import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import {
  PANO_TILE_W, PANO_TILE_H, PANORAMA_THRESHOLD, MIN_OVERLAP,
  type Box, type Tile,
} from "../shared/types.ts";
import { tilesDir } from "./storage.ts";

// Let sharp/libvips use all cores for the parallel tile encodes.
sharp.concurrency(os.cpus().length);

export function isPanorama(width: number, height: number): boolean {
  return Math.max(width, height) > PANORAMA_THRESHOLD;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

type AxisPlan = {
  count: number;
  size: number;
  /** fullBox start per index (overlapping window origin). */
  origins: number[];
  /** Shared cut lines, length count+1: seams[0]=0 … seams[count]=total.
   *  Interior seams sit at the middle of each overlap, so neighbouring crops
   *  share the exact same integer boundary → zero-gap, zero-overlap tiling. */
  seams: number[];
};

/** Plan one axis: how many tiles of `tileSize` cover `total` with an even,
 *  ≥MIN_OVERLAP seam. If the axis is shorter than a tile, one tile spans it. */
function planAxis(total: number, tileSize: number): AxisPlan {
  if (total <= tileSize) {
    return { count: 1, size: total, origins: [0], seams: [0, total] };
  }
  let count = Math.ceil(total / tileSize);
  // Adding a tile shrinks the step and therefore grows the overlap, so bump
  // count until the seam is at least MIN_OVERLAP (with a safety cap).
  for (let guard = 0; guard < 256; guard++) {
    const step = (total - tileSize) / (count - 1);
    const overlap = tileSize - step;
    if (overlap >= MIN_OVERLAP || count > 200) break;
    count++;
  }
  const step = (total - tileSize) / (count - 1);
  const overlap = tileSize - step;
  const origins: number[] = [];
  for (let i = 0; i < count; i++) {
    origins.push(Math.max(0, Math.min(Math.round(i * step), total - tileSize)));
  }
  const seams: number[] = [0];
  for (let i = 1; i < count; i++) {
    // middle of the overlap between tile i-1 and tile i
    seams.push(Math.round(i * step + overlap / 2));
  }
  seams.push(total);
  return { count, size: tileSize, origins, seams };
}

/** Compute the tile grid (geometry only) for a panorama of size w×h. */
export function computeTiles(w: number, h: number): { cols: number; rows: number; tiles: Tile[] } {
  const ax = planAxis(w, PANO_TILE_W);
  const ay = planAxis(h, PANO_TILE_H);
  const cols = ax.count, rows = ay.count;

  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // fullBox: the overlapping window (used later to send to fal).
      const fullBox: Box = { x: ax.origins[col], y: ay.origins[row], w: ax.size, h: ay.size };
      // cropBox: bounded by the shared seam lines → seamless re-assembly.
      const cropBox: Box = {
        x: ax.seams[col],
        y: ay.seams[row],
        w: ax.seams[col + 1] - ax.seams[col],
        h: ay.seams[row + 1] - ay.seams[row],
      };
      tiles.push({ id: randomUUID().slice(0, 8), col, row, fullBox, cropBox, status: "new" });
    }
  }
  return { cols, rows, tiles };
}

/** Cut every tile's FULL overlapping window (fullBox, 2208×1656) out of `srcPath`
 *  into `outPath(tile)`. `limitInputPixels:false` so huge panoramas (>268MP) load.
 *  The source is decoded once into a shared raw buffer, then all crops run in
 *  parallel (every core used, no per-tile re-decode). No .rotate(): crop coords
 *  must match the width/height used for tiling (panoramas are orientation=1). */
export async function renderTilesFrom(
  srcPath: string, tiles: Tile[], outPath: (t: Tile) => string, quality = 88,
) {
  const { data, info } = await sharp(srcPath, { limitInputPixels: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };

  const limit = Math.max(2, os.cpus().length);
  await mapPool(tiles, limit, async (t) => {
    const { x, y, w, h } = t.fullBox;
    const dst = outPath(t);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    await sharp(data, { raw, limitInputPixels: false })
      .extract({ left: x, top: y, width: w, height: h })
      .jpeg({ quality })
      .toFile(dst);
  });
}

/** Raw preview tiles cut from the original → tiles/<tileId>.jpg. */
export function renderTiles(projectId: string, origPath: string, tiles: Tile[]) {
  return renderTilesFrom(origPath, tiles, (t) => path.join(tilesDir(projectId), `${t.id}.jpg`));
}
