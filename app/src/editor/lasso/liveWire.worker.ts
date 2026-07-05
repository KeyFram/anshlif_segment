/// <reference lib="webworker" />
/* Live-wire (intelligent scissors) Dijkstra on a cached gradient map.
 * Worker keeps the edge map between requests so we don't re-transfer it
 * each click. Each request is constrained to a bbox window for speed. */

type SetEdgeMsg = {
  kind: "set-edge";
  w: number; h: number;
  grad: Float32Array;
  rgb: Uint8Array;       // packed RGB (3 bytes/px) for the colour wand
};
type RequestMsg = {
  kind: "request";
  reqId: number;
  seedX: number; seedY: number;
  targetX: number; targetY: number;   // current cursor corner — anchors the corridor
  corridor: number;                    // weight of the off-line deviation penalty
  threshold: number;                   // contrast below this is treated as flat (noise)
  x0: number; y0: number; x1: number; y1: number;
};
type WandMsg = {
  kind: "wand";
  reqId: number;
  seedX: number; seedY: number;
  x0: number; y0: number; x1: number; y1: number;
};
type Req = SetEdgeMsg | RequestMsg | WandMsg;
type Res = { reqId: number; parent: Int32Array };
type WandRes = {
  reqId: number; wand: true;
  cost: Uint8Array;                    // minimax edge cost (0..255) over the window
  x0: number; y0: number; x1: number; y1: number;
};

let GRAD: Float32Array | null = null;
let RGB: Uint8Array | null = null;     // packed RGB (3 bytes/px) for the colour wand
let W = 0, H = 0;

class Heap {
  private keys: Float32Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float32Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number) {
    let i = this.size++;
    this.keys[i] = k; this.vals[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      const tk = this.keys[p]; this.keys[p] = this.keys[i]; this.keys[i] = tk;
      const tv = this.vals[p]; this.vals[p] = this.vals[i]; this.vals[i] = tv;
      i = p;
    }
  }
  popVal(): number {
    const v = this.vals[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.vals[0] = this.vals[this.size];
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.size && this.keys[l] < this.keys[s]) s = l;
        if (r < this.size && this.keys[r] < this.keys[s]) s = r;
        if (s === i) break;
        const tk = this.keys[s]; this.keys[s] = this.keys[i]; this.keys[i] = tk;
        const tv = this.vals[s]; this.vals[s] = this.vals[i]; this.vals[i] = tv;
        i = s;
      }
    }
    return v;
  }
}

/* Dijkstra on the *pixel-corner* grid ((W+1) × (H+1) nodes). Each step moves
 * between two adjacent corners along one pixel boundary, so the resulting path
 * runs strictly *between* pixels — never through their centres. This matches
 * the snap/edge-graph path (which is already corner-based) and makes the cut
 * unambiguous: every pixel is clearly inside or outside the boundary.
 *
 * A corner-grid edge separates two pixels; its strength is the stronger
 * gradient of those two pixels. The step cost is
 *
 *     (1 − shaped_contrast) + BASE + corridor · distance_to_seed→target_line
 *
 * so a path is cheap when it (a) runs along a strong image edge AND (b) stays
 * near the straight line from the seed to the cursor. `shaped_contrast` zeroes
 * out anything below `threshold` (noise), and the corridor term keeps the path
 * from wandering off to grab faint, far-away contrast — over empty background
 * it collapses to a straight diagonal. Coords are corner coords (0..W, 0..H);
 * the returned parent array is in corner space ((W+1)×(H+1)). */
function runDijkstra(
  seedX: number, seedY: number, targetX: number, targetY: number,
  corridor: number, threshold: number,
  x0: number, y0: number, x1: number, y1: number,
): Int32Array {
  if (!GRAD) throw new Error("edge map not set");
  const grad = GRAD;
  const cornerW = W + 1;
  const winW = x1 - x0 + 1;
  const winN = winW * (y1 - y0 + 1);
  const dist = new Float32Array(winN);
  dist.fill(Infinity);
  const parent = new Int32Array(cornerW * (H + 1));
  parent.fill(-1);
  const heap = new Heap(winN);

  const seedWinIdx = (seedY - y0) * winW + (seedX - x0);
  dist[seedWinIdx] = 0;
  heap.push(0, seedWinIdx);
  parent[seedY * cornerW + seedX] = seedY * cornerW + seedX;

  const BASE = 0.02;
  const invSpan = 1 / Math.max(1e-6, 1 - threshold);

  // Contrast shaping: below `threshold` → 0 (treated as flat background);
  // above → rescaled to 0..1. Squared to further damp weak contrast.
  const shape = (s: number): number => {
    if (s <= threshold) return 0;
    const v = (s - threshold) * invSpan;
    return v * v;
  };
  // Boundary strengths (stronger gradient of the two pixels the segment splits).
  const hStrength = (cx: number, cy: number): number => {
    let s = 0;
    if (cy - 1 >= 0 && cy - 1 < H) { const g = grad[(cy - 1) * W + cx]; if (g > s) s = g; }
    if (cy >= 0 && cy < H)         { const g = grad[cy * W + cx];       if (g > s) s = g; }
    return s;
  };
  const vStrength = (cx: number, cy: number): number => {
    let s = 0;
    if (cx - 1 >= 0 && cx - 1 < W) { const g = grad[cy * W + (cx - 1)]; if (g > s) s = g; }
    if (cx >= 0 && cx < W)         { const g = grad[cy * W + cx];       if (g > s) s = g; }
    return s;
  };
  // Distance from corner (cx,cy) to the seed→target segment.
  const segDX = targetX - seedX, segDY = targetY - seedY;
  const segLen2 = segDX * segDX + segDY * segDY;
  const dev = (cx: number, cy: number): number => {
    let t = segLen2 > 0 ? ((cx - seedX) * segDX + (cy - seedY) * segDY) / segLen2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = seedX + t * segDX, qy = seedY + t * segDY;
    const ex = cx - qx, ey = cy - qy;
    return Math.sqrt(ex * ex + ey * ey);
  };

  while (heap.size > 0) {
    const winIdx = heap.popVal();
    const wy = (winIdx / winW) | 0;
    const wx = winIdx - wy * winW;
    const pd = dist[winIdx];
    if (pd === Infinity) continue;
    const cx = x0 + wx;
    const cy = y0 + wy;
    const fromIdx = cy * cornerW + cx;

    // 4 corner neighbours, each crossing one pixel-boundary segment.
    if (cx + 1 <= x1 && cx + 1 <= W) {
      const nd = pd + (1 - shape(hStrength(cx, cy))) + BASE + corridor * dev(cx + 1, cy);
      const nWin = wy * winW + (wx + 1);
      if (nd < dist[nWin]) { dist[nWin] = nd; parent[cy * cornerW + (cx + 1)] = fromIdx; heap.push(nd, nWin); }
    }
    if (cx - 1 >= x0 && cx - 1 >= 0) {
      const nd = pd + (1 - shape(hStrength(cx - 1, cy))) + BASE + corridor * dev(cx - 1, cy);
      const nWin = wy * winW + (wx - 1);
      if (nd < dist[nWin]) { dist[nWin] = nd; parent[cy * cornerW + (cx - 1)] = fromIdx; heap.push(nd, nWin); }
    }
    if (cy + 1 <= y1 && cy + 1 <= H) {
      const nd = pd + (1 - shape(vStrength(cx, cy))) + BASE + corridor * dev(cx, cy + 1);
      const nWin = (wy + 1) * winW + wx;
      if (nd < dist[nWin]) { dist[nWin] = nd; parent[(cy + 1) * cornerW + cx] = fromIdx; heap.push(nd, nWin); }
    }
    if (cy - 1 >= y0 && cy - 1 >= 0) {
      const nd = pd + (1 - shape(vStrength(cx, cy - 1))) + BASE + corridor * dev(cx, cy - 1);
      const nWin = (wy - 1) * winW + wx;
      if (nd < dist[nWin]) { dist[nWin] = nd; parent[(cy - 1) * cornerW + cx] = fromIdx; heap.push(nd, nWin); }
    }
  }
  return parent;
}

/* Colour magic-wand flood. cost(pixel) = the smallest tolerance at which the
 * pixel is colour-connected to the seed, i.e. the minimax over paths of the
 * per-pixel colour distance to the *seed* colour (max channel difference,
 * 0..255). The selection at tolerance L is {cost ≤ L} — the contiguous blob
 * whose colour stays within L of the clicked colour. Solved in O(N) with a
 * 256-bucket queue (minimax cost is monotone along a path). */
function runWand(seedX: number, seedY: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  if (!RGB) throw new Error("colour map not set");
  const rgb = RGB;
  const w = W;
  const winW = x1 - x0 + 1;
  const winH = y1 - y0 + 1;
  const cost = new Uint8Array(winW * winH);
  cost.fill(255);
  const si = (seedY * w + seedX) * 3;
  const sr = rgb[si], sg = rgb[si + 1], sb = rgb[si + 2];
  // Colour distance of pixel index `p` to the seed colour (max channel diff).
  const dist = (p: number): number => {
    const o = p * 3;
    const dr = Math.abs(rgb[o] - sr);
    const dg = Math.abs(rgb[o + 1] - sg);
    const db = Math.abs(rgb[o + 2] - sb);
    return dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
  };

  const buckets: number[][] = Array.from({ length: 256 }, () => []);
  const seedWin = (seedY - y0) * winW + (seedX - x0);
  cost[seedWin] = 0;                              // seed colour distance to itself
  buckets[0].push(seedWin);

  for (let c = 0; c < 256; c++) {
    const bucket = buckets[c];
    for (let bi = 0; bi < bucket.length; bi++) {
      const winIdx = bucket[bi];
      if (cost[winIdx] !== c) continue;          // stale (settled cheaper already)
      const wy = (winIdx / winW) | 0;
      const wx = winIdx - wy * winW;
      const px = x0 + wx, py = y0 + wy;
      for (let k = 0; k < 4; k++) {
        const nx = px + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = py + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const nWin = (ny - y0) * winW + (nx - x0);
        const nc = Math.max(c, dist(ny * w + nx));  // minimax of colour-to-seed
        if (nc < cost[nWin]) { cost[nWin] = nc; buckets[nc].push(nWin); }
      }
    }
  }
  return cost;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  if (msg.kind === "set-edge") {
    GRAD = msg.grad;
    RGB = msg.rgb;
    W = msg.w; H = msg.h;
    return;
  }
  if (msg.kind === "wand") {
    const cost = runWand(msg.seedX, msg.seedY, msg.x0, msg.y0, msg.x1, msg.y1);
    const res: WandRes = { reqId: msg.reqId, wand: true, cost, x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1 };
    (self as unknown as Worker).postMessage(res, [cost.buffer]);
    return;
  }
  const parent = runDijkstra(
    msg.seedX, msg.seedY, msg.targetX, msg.targetY,
    msg.corridor, msg.threshold,
    msg.x0, msg.y0, msg.x1, msg.y1,
  );
  const res: Res = { reqId: msg.reqId, parent };
  (self as unknown as Worker).postMessage(res, [parent.buffer]);
};
