import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type {
  Domain, ImageKind, ImageMeta, ProjectImage, PhaseFraction, PreviewParams,
} from "../shared/types.ts";
import { isPanorama, computeTiles, renderTiles, renderTilesFrom } from "./panorama.ts";
import { normalizeBatch, normalizeWhole, type NormTask } from "./normalize.ts";
import { segmentImage } from "./segment.ts";
import { falConfigured, PYTHON_BIN, pythonEnv } from "./config.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProject, listSummaries, toSummary } from "./projects.ts";
import {
  readProject, writeProject, deleteProject,
  origDir, tilesDir, normDir, masksDir, projectDir, ensureProjectDirs,
} from "./storage.ts";

const PORT = 3001;
const app = express();
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 200 },  // panoramas can be huge
});

const DOMAINS: Domain[] = ["microscopy", "xrd"];

function extFromName(name: string): string {
  const e = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return e || ".png";
}

const defaultMeta = (): ImageMeta => ({
  umPerPixel: null,
  shooting: { camera: "", aperture: "", shutter: "", iso: "" },
  deposit: "",
  exif: {},
});

// ---------------- Projects CRUD ----------------
app.get("/api/projects", (req, res) => {
  const domain = req.query.domain as Domain | undefined;
  res.json(listSummaries(domain && DOMAINS.includes(domain) ? domain : undefined));
});

app.post("/api/projects", (req, res) => {
  const { name, domain } = req.body as { name?: string; domain?: Domain };
  const d: Domain = domain && DOMAINS.includes(domain) ? domain : "microscopy";
  const project = createProject(name ?? "", d);
  res.json(project);
});

app.get("/api/projects/:id", (req, res) => {
  const p = readProject(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

app.delete("/api/projects/:id", (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: "not found" });
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// Delete one image (single or panorama) and every file it owns.
app.delete("/api/projects/:id/images/:imageId", (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const idx = project.images.findIndex((i) => i.id === req.params.imageId);
  if (idx < 0) return res.status(404).json({ error: "image not found" });
  const img = project.images[idx];
  const rm = (p: string) => fs.rmSync(p, { force: true });

  rm(path.join(origDir(project.id), img.origFile));
  if (img.tiles) {
    for (const t of img.tiles) {
      rm(path.join(tilesDir(project.id), `${t.id}.jpg`));
      rm(path.join(normDir(project.id), `tile_${t.id}.jpg`));
      rm(path.join(masksDir(project.id), `tile_${t.id}.png`));
    }
  } else {
    rm(path.join(normDir(project.id), `single_${img.id}.jpg`));
    rm(path.join(masksDir(project.id), `single_${img.id}.png`));
  }

  project.images.splice(idx, 1);
  writeProject(project);
  res.json({ ok: true, project: toSummary(project) });
});

// ---------------- Upload ----------------
// multipart: files[] + a JSON "payload" field { applyAll, metas: ImageMeta[] }.
app.post("/api/projects/:id/upload", upload.array("files"), async (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "no files" });

  let payload: { applyAll?: boolean; metas?: ImageMeta[]; kinds?: ImageKind[] } = {};
  try { payload = JSON.parse((req.body?.payload as string) ?? "{}"); } catch {}
  const metas = payload.metas ?? [];
  const kinds = payload.kinds ?? [];
  const metaFor = (i: number): ImageMeta =>
    payload.applyAll ? (metas[0] ?? defaultMeta()) : (metas[i] ?? defaultMeta());
  // Kind is a user choice now (some singles are 6k+, so resolution can't decide).
  // Fall back to the resolution heuristic only if the client sent nothing.
  const kindFor = (i: number, w: number, h: number): ImageKind => {
    const k = payload.applyAll ? kinds[0] : kinds[i];
    return k ?? (isPanorama(w, h) ? "panorama" : "single");
  };

  ensureProjectDirs(project.id);
  const added: ProjectImage[] = [];
  const normTasks: NormTask[] = [];   // images/tiles to normalize for the preview

  try {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const id = randomUUID().slice(0, 8);
    const ext = extFromName(file.originalname);
    const origFile = `${id}${ext}`;
    const origPath = path.join(origDir(project.id), origFile);
    fs.writeFileSync(origPath, file.buffer);

    let width = 0, height = 0;
    try {
      const m = await sharp(file.buffer, { limitInputPixels: false }).metadata();
      width = m.width ?? 0; height = m.height ?? 0;
    } catch { /* leave 0×0 if unreadable */ }

    const pano = kindFor(i, width, height) === "panorama";
    const image: ProjectImage = {
      id,
      name: file.originalname,
      kind: pano ? "panorama" : "single",
      origFile,
      width, height,
      meta: metaFor(i),
      status: "new",
    };
    if (pano && width > 0 && height > 0) {
      const { tiles } = computeTiles(width, height);
      // Raw tiles (for the "нормализация выкл" toggle + Space peek).
      await renderTiles(project.id, origPath, tiles);
      // Normalize the WHOLE panorama once, then cut the normalized tiles from it
      // — one global correction → seamless tiles that match the training set.
      const normFull = path.join(projectDir(project.id), `_normfull_${id}.jpg`);
      const ok = await normalizeWhole(origPath, normFull);
      if (ok) {
        await renderTilesFrom(normFull, tiles, (t) => path.join(normDir(project.id), `tile_${t.id}.jpg`), 95);
        fs.rmSync(normFull, { force: true });
      }
      image.tiles = tiles;
    } else {
      normTasks.push({ src: origPath, key: `single_${id}` });
    }
    project.images.push(image);
    added.push(image);
  }

  // Normalized single previews (colour-cast + exposure → reference). Non-fatal.
  await normalizeBatch(project.id, normTasks);

  writeProject(project);
  res.json({ images: added, project: toSummary(project) });
  } catch (e) {
    console.error("upload processing failed:", e);
    // Persist whatever succeeded so partial uploads aren't lost.
    try { writeProject(project); } catch {}
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

// ---------------- Serve image bytes ----------------
app.get("/api/projects/:id/orig/:imageId", (req, res) => {
  const p = readProject(req.params.id);
  const img = p?.images.find((im) => im.id === req.params.imageId);
  if (!img) return res.status(404).end();
  const abs = path.join(origDir(req.params.id), img.origFile);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

app.get("/api/projects/:id/tile/:tileId", (req, res) => {
  const abs = path.join(tilesDir(req.params.id), `${path.basename(req.params.tileId)}.jpg`);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

// Normalized single: norm/single_<imageId>.jpg, falling back to the raw original
// so the toggle never shows a broken image if normalization was skipped/failed.
app.get("/api/projects/:id/norm/:imageId", (req, res) => {
  const p = readProject(req.params.id);
  const img = p?.images.find((im) => im.id === req.params.imageId);
  if (!img) return res.status(404).end();
  const norm = path.join(normDir(req.params.id), `single_${path.basename(req.params.imageId)}.jpg`);
  if (fs.existsSync(norm)) return res.sendFile(norm);
  const orig = path.join(origDir(req.params.id), img.origFile);
  if (fs.existsSync(orig)) return res.sendFile(orig);
  res.status(404).end();
});

// Normalized tile: norm/tile_<tileId>.jpg, falling back to the raw tile.
app.get("/api/projects/:id/tilenorm/:tileId", (req, res) => {
  const base = path.basename(req.params.tileId);
  const norm = path.join(normDir(req.params.id), `tile_${base}.jpg`);
  if (fs.existsSync(norm)) return res.sendFile(norm);
  const raw = path.join(tilesDir(req.params.id), `${base}.jpg`);
  if (fs.existsSync(raw)) return res.sendFile(raw);
  res.status(404).end();
});

// ---------------- Segmentation (fal) ----------------
app.get("/api/config", (_req, res) => {
  res.json({ falConfigured: falConfigured() });
});

// Input for segmentation: the NORMALIZED image (that's the point of normalize),
// falling back to the raw tile/original if normalization was skipped.
function segInputPath(projectId: string, key: string, rawFallback: string): string {
  const norm = path.join(normDir(projectId), `${key}.jpg`);
  return fs.existsSync(norm) ? norm : rawFallback;
}

// Update one item's fields by re-reading first (limits clobber between the
// "processing" write and the concurrent long-running segment of another item).
function patchItem(projectId: string, imageId: string, tileId: string | undefined,
                   patch: Partial<ProjectImage & { phases: unknown }>) {
  const p = readProject(projectId);
  if (!p) return;
  const img = p.images.find((i) => i.id === imageId);
  if (!img) return;
  if (tileId) {
    const t = img.tiles?.find((tt) => tt.id === tileId);
    if (t) Object.assign(t, patch);
  } else {
    Object.assign(img, patch);
  }
  writeProject(p);
}

app.post("/api/projects/:id/segment", async (req, res) => {
  const projectId = req.params.id;
  const project = readProject(projectId);
  if (!project) return res.status(404).json({ error: "not found" });
  if (!falConfigured()) return res.status(400).json({ error: "fal не настроен (нет FAL_KEY/LORA_URL)" });

  const { imageId, tileId, hint } = req.body as { imageId?: string; tileId?: string; hint?: string };
  const img = project.images.find((i) => i.id === imageId);
  if (!img || !imageId) return res.status(404).json({ error: "image not found" });

  let key: string, rawFallback: string;
  if (tileId) {
    const tile = img.tiles?.find((t) => t.id === tileId);
    if (!tile) return res.status(404).json({ error: "tile not found" });
    key = `tile_${tileId}`;
    rawFallback = path.join(tilesDir(projectId), `${tileId}.jpg`);
  } else {
    key = `single_${imageId}`;
    rawFallback = path.join(origDir(projectId), img.origFile);
  }

  ensureProjectDirs(projectId);
  patchItem(projectId, imageId, tileId, { status: "processing" });

  try {
    const inputPath = segInputPath(projectId, key, rawFallback);
    const outPath = path.join(masksDir(projectId), `${key}.png`);
    const { phases } = await segmentImage(inputPath, outPath, hint);
    patchItem(projectId, imageId, tileId, { status: "done", phases } as any);
    res.json({ ok: true, imageId, tileId, phases });
  } catch (e) {
    console.error("segment failed:", e);
    patchItem(projectId, imageId, tileId, { status: "error" });
    res.status(500).json({ error: String(e) });
  }
});

// Save per-file competition-preview params (thin/normal thresholds + opacity).
app.put("/api/projects/:id/previewparams/:key", (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const found = findByKey(project, path.basename(req.params.key));
  if (!found) return res.status(404).json({ error: "item not found" });
  const params = req.body as PreviewParams;
  if (found.tile) found.tile.previewParams = params;
  else found.img.previewParams = params;
  writeProject(project);
  res.json({ ok: true });
});

// Serve masks (single / tile). 404 if not segmented yet.
app.get("/api/projects/:id/imagemask/:imageId", (req, res) => {
  const abs = path.join(masksDir(req.params.id), `single_${path.basename(req.params.imageId)}.png`);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});
app.get("/api/projects/:id/tilemask/:tileId", (req, res) => {
  const abs = path.join(masksDir(req.params.id), `tile_${path.basename(req.params.tileId)}.png`);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

// Count each phase colour's share in the saved mask (for the legend).
async function recomputeFractions(
  pngBuffer: Buffer,
  phases: { name: string; color: [number, number, number] }[],
): Promise<PhaseFraction[]> {
  const { data, info } = await sharp(pngBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  const counts = new Array(phases.length).fill(0);
  const ch = info.channels;
  for (let i = 0; i < total; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    for (let k = 0; k < phases.length; k++) {
      const c = phases[k].color;
      if (r === c[0] && g === c[1] && b === c[2]) { counts[k]++; break; }
    }
  }
  return phases.map((p, k) => ({ name: p.name, color: p.color, fraction: total ? counts[k] / total : 0 }));
}

function findByKey(project: ReturnType<typeof readProject>, key: string) {
  if (!project) return null;
  if (key.startsWith("single_")) {
    const img = project.images.find((i) => i.id === key.slice(7));
    return img ? { img, tile: undefined } : null;
  }
  if (key.startsWith("tile_")) {
    const tid = key.slice(5);
    for (const img of project.images) {
      const tile = img.tiles?.find((t) => t.id === tid);
      if (tile) return { img, tile };
    }
  }
  return null;
}

// Save a hand-edited mask (base64 PNG) + its phases; recompute area shares.
app.put("/api/projects/:id/mask/:key", async (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const key = path.basename(req.params.key);
  const found = findByKey(project, key);
  if (!found) return res.status(404).json({ error: "item not found" });

  const { pngBase64, phases } = req.body as {
    pngBase64?: string;
    phases?: { name: string; color: [number, number, number] }[];
  };
  if (!pngBase64) return res.status(400).json({ error: "missing pngBase64" });

  const buf = Buffer.from(pngBase64, "base64");
  ensureProjectDirs(project.id);
  fs.writeFileSync(path.join(masksDir(project.id), `${key}.png`), buf);

  let fractions: PhaseFraction[] = found.tile?.phases ?? found.img.phases ?? [];
  if (phases && phases.length) {
    try { fractions = await recomputeFractions(buf, phases); } catch (e) { console.error("fraction recompute:", e); }
  }
  if (found.tile) { found.tile.phases = fractions; found.tile.status = "done"; }
  else { found.img.phases = fractions; found.img.status = "done"; }
  writeProject(project);
  res.json({ ok: true, phases: fractions });
});

// ---------------- Export (ZIP of competition masks) ----------------
const EXPORT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "export", "export.py");

app.post("/api/projects/:id/export", async (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const { mask = true, orig = false, overlay = false, name } = req.body as {
    mask?: boolean; orig?: boolean; overlay?: boolean; name?: string;
  };
  const zipPath = path.join(projectDir(project.id), `_export_${Date.now()}.zip`);
  const safeName = (name?.trim() || project.name || "export").replace(/[^\p{L}\p{N}_\- ]/gu, "").trim() || "export";

  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(PYTHON_BIN, [EXPORT_SCRIPT, projectDir(project.id), zipPath], {
        env: { ...pythonEnv(), EXPORT_OPTS: JSON.stringify({ mask, orig, overlay }) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", reject);
      p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`export exit ${code}: ${err.slice(-500)}`)));
    });
    res.download(zipPath, `${safeName}.zip`, () => {
      fs.rmSync(zipPath, { force: true });
    });
  } catch (e) {
    console.error("export failed:", e);
    fs.rmSync(zipPath, { force: true });
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

// ---------------- Report (project HTML, print-ready A4) ----------------
const REPORT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "report", "report.py");

app.get("/api/projects/:id/report", async (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).send("not found");
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const p = spawn(PYTHON_BIN, [REPORT_SCRIPT, projectDir(project.id)], {
        env: pythonEnv(), stdio: ["ignore", "pipe", "pipe"],
      });
      let out = Buffer.alloc(0), err = "";
      p.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", reject);
      p.on("close", (code) => code === 0 ? resolve(out.toString("utf8")) : reject(new Error(`report exit ${code}: ${err.slice(-500)}`)));
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("report failed:", e);
    res.status(500).send(`Ошибка отчёта: ${e}`);
  }
});

app.listen(PORT, () => {
  console.log(`Nornikel site API on http://localhost:${PORT}`);
  console.log(`fal configured: ${falConfigured()}`);
});
