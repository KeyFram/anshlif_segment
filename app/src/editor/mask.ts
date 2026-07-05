export type RGB = [number, number, number];
export type Phase = { name: string; color: RGB };
export type MaskData = {
  width: number;
  height: number;
  labels: Uint8Array;   // index into phases[], length = width * height
  phases: Phase[];      // discovered (or merged with phases.json)
};

/** Parse a quantized mask image into a labels array + a phase list.
 *
 *  When `phasesJson` is present it is AUTHORITATIVE: its ordered list defines
 *  the phases (names + colours), and each pixel colour is matched to a phase by
 *  exact RGB. This lets phases with no pixels yet (just created, not painted)
 *  survive a save/reload — they live in phases.json even though the PNG, being
 *  colour-keyed, can't represent an empty phase. Any image colour not covered
 *  by the list is appended as a freshly-discovered phase. */
export function parseMask(img: HTMLImageElement, phasesJson?: Phase[]): MaskData {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;

  const colorMap = new Map<number, number>();   // packed RGB → phase index
  const phases: Phase[] = [];
  if (phasesJson) {
    for (const p of phasesJson) {
      const key = (p.color[0] << 16) | (p.color[1] << 8) | p.color[2];
      if (colorMap.has(key)) continue;           // ignore duplicate-colour entries
      colorMap.set(key, phases.length);
      phases.push({ name: p.name, color: [p.color[0], p.color[1], p.color[2]] });
    }
  }

  const labels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let idx = colorMap.get(key);
    if (idx === undefined) {
      idx = phases.length;
      colorMap.set(key, idx);
      phases.push({ name: `Фаза ${idx + 1}`, color: [r, g, b] });
    }
    labels[i] = idx;
  }
  return { width: w, height: h, labels, phases };
}

/** A phase colour not used by any phase in `phases` (so a freshly added empty
 *  phase is distinguishable and round-trips through the colour-keyed PNG). */
export function pickUnusedColor(phases: Phase[]): RGB {
  const used = new Set(phases.map((p) => (p.color[0] << 16) | (p.color[1] << 8) | p.color[2]));
  const palette: RGB[] = [
    [228, 26, 28], [55, 126, 184], [77, 175, 74], [152, 78, 163],
    [255, 127, 0], [255, 215, 0], [166, 86, 40], [247, 129, 191],
    [0, 206, 209], [255, 105, 180], [124, 252, 0], [148, 0, 211],
  ];
  for (const c of palette) {
    if (!used.has((c[0] << 16) | (c[1] << 8) | c[2])) return c;
  }
  for (let t = 1; t < 1 << 16; t++) {            // deterministic fallback search
    const r = (t * 53) & 255, g = (t * 101) & 255, b = (t * 151) & 255;
    if (!used.has((r << 16) | (g << 8) | b)) return [r, g, b];
  }
  return [128, 128, 128];
}

/** Render the labels+phases back into an ImageData (RGBA, fully opaque). */
export function renderMaskImageData(m: MaskData): ImageData {
  const data = new Uint8ClampedArray(m.width * m.height * 4);
  for (let i = 0; i < m.labels.length; i++) {
    const [r, g, b] = m.phases[m.labels[i]].color;
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, m.width, m.height);
}

/** Border-edge graph: every inter-class pixel boundary as a graph edge
 *  between pixel-corners ((w+1) × (h+1) grid). Edges that share an endpoint
 *  AND separate the same pair of classes get the same `edgeId` (so they
 *  form one connected contour). Provides a spatial grid for fast snap
 *  lookup and adjacency for path BFS along a contour. */
export type EdgeGraph = {
  /** count of border edges. */
  count: number;
  /** corner-A endpoint, image coords, integer */
  ax: Int16Array; ay: Int16Array;
  /** corner-B endpoint */
  bx: Int16Array; by: Int16Array;
  /** phase classes on each side. (classA is the side reachable via
   *  the (-1, 0) or (0, -1) normal; classB the opposite.) */
  classA: Uint8Array; classB: Uint8Array;
  /** id of the connected contour this edge belongs to. */
  edgeIds: Int32Array;
  /** spatial bucket: cell (x, y) → edge indices intersecting the cell. */
  cellSize: number;
  gridW: number; gridH: number;
  grid: Int32Array[];
  /** for path-BFS: corner index → edge indices touching this corner. */
  cornerToEdges: Map<number, number[]>;
  /** width of the corner grid (= image width + 1). */
  cornerW: number;
};

/** Per-phase outline segments for rendering, with inward normals. */
export type Segments = { perPhase: Float32Array[] };

/** Sentinel class id for the image-boundary side of a border edge. */
export const BOUNDARY_CLASS = 255;

/** Build the edge graph + the per-phase render segments from a single pass.
 *  The graph includes the outer image-rectangle as edges too, so the lasso
 *  can snap to / traverse the image border just like any inter-class edge. */
export function computeEdgeData(m: MaskData): { graph: EdgeGraph; segments: Segments } {
  const { width: w, height: h, labels, phases } = m;
  const cornerW = w + 1;

  // ---- Pass 1: count border edges (inter-class) and per-phase segment counts.
  let interEdgeCount = 0;
  const phaseCounts = new Int32Array(phases.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lab = labels[i];
      if (x < w - 1 && labels[i + 1] !== lab) { interEdgeCount++; phaseCounts[lab]++; phaseCounts[labels[i + 1]]++; }
      if (y < h - 1 && labels[i + w] !== lab) { interEdgeCount++; phaseCounts[lab]++; phaseCounts[labels[i + w]]++; }
    }
  }
  // Plus the image frame: 2*w horizontal + 2*h vertical boundary edges.
  const frameEdgeCount = 2 * w + 2 * h;
  const edgeCount = interEdgeCount + frameEdgeCount;

  // ---- Pass 2: fill structures.
  const ax = new Int16Array(edgeCount);
  const ay = new Int16Array(edgeCount);
  const bx = new Int16Array(edgeCount);
  const by = new Int16Array(edgeCount);
  const classA = new Uint8Array(edgeCount);
  const classB = new Uint8Array(edgeCount);
  const perPhase: Float32Array[] = phases.map((_, idx) => new Float32Array(phaseCounts[idx] * 6));
  const phaseCursors = new Int32Array(phases.length);
  const cornerToEdges = new Map<number, number[]>();
  const addCorner = (cornerIdx: number, eIdx: number) => {
    let arr = cornerToEdges.get(cornerIdx);
    if (!arr) { arr = []; cornerToEdges.set(cornerIdx, arr); }
    arr.push(eIdx);
  };
  const pushSeg = (phase: number, x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
    const arr = perPhase[phase];
    const j = phaseCursors[phase]++ * 6;
    arr[j]     = x0;
    arr[j + 1] = y0;
    arr[j + 2] = x1;
    arr[j + 3] = y1;
    arr[j + 4] = nx;
    arr[j + 5] = ny;
  };

  let e = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lab = labels[i];
      if (x < w - 1 && labels[i + 1] !== lab) {
        const nei = labels[i + 1];
        // Vertical edge at x+1, between corners (x+1, y) and (x+1, y+1).
        ax[e] = x + 1; ay[e] = y;
        bx[e] = x + 1; by[e] = y + 1;
        classA[e] = lab;     // left side  (nx = -1)
        classB[e] = nei;     // right side (nx = +1)
        addCorner((y)     * cornerW + (x + 1), e);
        addCorner((y + 1) * cornerW + (x + 1), e);
        pushSeg(lab, x + 1, y, x + 1, y + 1, -1, 0);
        pushSeg(nei, x + 1, y, x + 1, y + 1, +1, 0);
        e++;
      }
      if (y < h - 1 && labels[i + w] !== lab) {
        const nei = labels[i + w];
        // Horizontal edge at y+1, between corners (x, y+1) and (x+1, y+1).
        ax[e] = x;     ay[e] = y + 1;
        bx[e] = x + 1; by[e] = y + 1;
        classA[e] = lab;     // top side    (ny = -1)
        classB[e] = nei;     // bottom side (ny = +1)
        addCorner((y + 1) * cornerW + x,       e);
        addCorner((y + 1) * cornerW + (x + 1), e);
        pushSeg(lab, x, y + 1, x + 1, y + 1, 0, -1);
        pushSeg(nei, x, y + 1, x + 1, y + 1, 0, +1);
        e++;
      }
    }
  }

  // Frame edges — the outer image rectangle. The non-image side gets the
  // BOUNDARY_CLASS sentinel so they don't share class pairs with inter-class
  // edges and therefore form their own edgeId(s).
  // Top: corners (x, 0) ↔ (x+1, 0), the inside class is labels[x].
  for (let x = 0; x < w; x++) {
    const lab = labels[x];
    ax[e] = x;     ay[e] = 0;
    bx[e] = x + 1; by[e] = 0;
    classA[e] = BOUNDARY_CLASS; classB[e] = lab;
    addCorner(0 * cornerW + x,       e);
    addCorner(0 * cornerW + (x + 1), e);
    e++;
  }
  // Bottom: corners (x, h) ↔ (x+1, h), inside class is labels[(h-1)*w + x].
  for (let x = 0; x < w; x++) {
    const lab = labels[(h - 1) * w + x];
    ax[e] = x;     ay[e] = h;
    bx[e] = x + 1; by[e] = h;
    classA[e] = lab; classB[e] = BOUNDARY_CLASS;
    addCorner(h * cornerW + x,       e);
    addCorner(h * cornerW + (x + 1), e);
    e++;
  }
  // Left: corners (0, y) ↔ (0, y+1), inside class is labels[y*w].
  for (let y = 0; y < h; y++) {
    const lab = labels[y * w];
    ax[e] = 0; ay[e] = y;
    bx[e] = 0; by[e] = y + 1;
    classA[e] = BOUNDARY_CLASS; classB[e] = lab;
    addCorner(y * cornerW,         e);
    addCorner((y + 1) * cornerW,   e);
    e++;
  }
  // Right: corners (w, y) ↔ (w, y+1), inside class is labels[y*w + (w-1)].
  for (let y = 0; y < h; y++) {
    const lab = labels[y * w + (w - 1)];
    ax[e] = w; ay[e] = y;
    bx[e] = w; by[e] = y + 1;
    classA[e] = lab; classB[e] = BOUNDARY_CLASS;
    addCorner(y * cornerW + w,       e);
    addCorner((y + 1) * cornerW + w, e);
    e++;
  }

  // ---- Pass 3: assign edgeIds via union-find.
  //  Edges that share a corner AND separate the same pair of classes merge.
  const parent = new Int32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // path compression
    while (parent[x] !== r) { const nxt = parent[x]; parent[x] = r; x = nxt; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const pairKey = (e: number) =>
    classA[e] < classB[e] ? (classA[e] | (classB[e] << 8)) : (classB[e] | (classA[e] << 8));
  for (const list of cornerToEdges.values()) {
    if (list.length < 2) continue;
    // Group edges at this corner by class pair, union within each group.
    const byPair = new Map<number, number>();   // pairKey → representative edge idx
    for (const eIdx of list) {
      const key = pairKey(eIdx);
      const rep = byPair.get(key);
      if (rep === undefined) byPair.set(key, eIdx);
      else union(rep, eIdx);
    }
  }
  const edgeIds = new Int32Array(edgeCount);
  const rootToId = new Map<number, number>();
  let nextId = 0;
  for (let i = 0; i < edgeCount; i++) {
    const r = find(i);
    let id = rootToId.get(r);
    if (id === undefined) { id = nextId++; rootToId.set(r, id); }
    edgeIds[i] = id;
  }

  // ---- Pass 4: spatial grid.
  const cellSize = 16;
  const gridW = Math.ceil(w / cellSize);
  const gridH = Math.ceil(h / cellSize);
  const cellBuckets: number[][] = new Array(gridW * gridH);
  for (let i = 0; i < edgeCount; i++) {
    // midpoint
    const mx = (ax[i] + bx[i]) * 0.5;
    const my = (ay[i] + by[i]) * 0.5;
    const cx = Math.min(gridW - 1, Math.max(0, Math.floor(mx / cellSize)));
    const cy = Math.min(gridH - 1, Math.max(0, Math.floor(my / cellSize)));
    const k = cy * gridW + cx;
    if (!cellBuckets[k]) cellBuckets[k] = [];
    cellBuckets[k].push(i);
  }
  const grid: Int32Array[] = new Array(gridW * gridH);
  for (let k = 0; k < grid.length; k++) {
    grid[k] = cellBuckets[k] ? Int32Array.from(cellBuckets[k]) : EMPTY_I32;
  }

  // Merge each phase's unit border segments into long collinear runs. The
  // outline is stroked tens of thousands of segments at a time; collapsing a
  // straight run of N unit segments into one cuts the stroke/build cost
  // proportionally. It is pixel-identical: collinear unit segments with a
  // "square" cap each overhang the shared joint by half the line width, so
  // their union is exactly the merged segment's stroke.
  const mergedPerPhase = perPhase.map(mergeCollinearSegments);

  return {
    graph: {
      count: edgeCount,
      ax, ay, bx, by,
      classA, classB,
      edgeIds,
      cellSize, gridW, gridH, grid,
      cornerToEdges,
      cornerW,
    },
    segments: { perPhase: mergedPerPhase },
  };
}

/** Merge unit-length, axis-aligned, same-normal border segments that meet
 *  end-to-end into single long segments. Input/output share the 6-float layout
 *  [x0, y0, x1, y1, nx, ny]. Axis-aligned + same normal guarantees the run is
 *  collinear, so the result strokes identically. */
function mergeCollinearSegments(seg: Float32Array): Float32Array {
  // Group by the line a segment lives on, keyed together with its normal sign
  // (segments on the same grid line but with opposite normals are inset to
  // different places and must not merge). Vertical edges (ny===0) are grouped
  // by x; horizontal edges by y. Within a group we collect the unit-cell start
  // coordinate and later stitch consecutive ones.
  const vert = new Map<number, number[]>();   // key(x,nx) → list of y starts
  const horz = new Map<number, number[]>();   // key(y,ny) → list of x starts
  for (let k = 0; k < seg.length; k += 6) {
    const x0 = seg[k], y0 = seg[k + 1], x1 = seg[k + 2], y1 = seg[k + 3];
    const nx = seg[k + 4], ny = seg[k + 5];
    if (ny === 0) {
      const key = (x0 << 1) | (nx > 0 ? 1 : 0);
      let a = vert.get(key); if (!a) { a = []; vert.set(key, a); }
      a.push(Math.min(y0, y1));
    } else {
      const key = (y0 << 1) | (ny > 0 ? 1 : 0);
      let a = horz.get(key); if (!a) { a = []; horz.set(key, a); }
      a.push(Math.min(x0, x1));
    }
  }
  const out: number[] = [];
  for (const [key, ys] of vert) {
    const x = key >> 1, nx = (key & 1) ? 1 : -1;
    ys.sort((a, b) => a - b);
    let s = ys[0], prev = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i < ys.length && ys[i] === prev + 1) { prev = ys[i]; continue; }
      out.push(x, s, x, prev + 1, nx, 0);   // run covers [s, prev+1]
      if (i < ys.length) { s = ys[i]; prev = ys[i]; }
    }
  }
  for (const [key, xs] of horz) {
    const y = key >> 1, ny = (key & 1) ? 1 : -1;
    xs.sort((a, b) => a - b);
    let s = xs[0], prev = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === prev + 1) { prev = xs[i]; continue; }
      out.push(s, y, prev + 1, y, 0, ny);
      if (i < xs.length) { s = xs[i]; prev = xs[i]; }
    }
  }
  return Float32Array.from(out);
}

const EMPTY_I32 = new Int32Array(0);

/** Closest point on segment AB to point P (returns t∈[0,1] and squared dist). */
function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
  return { t, cx, cy, d2 };
}

export type Snap = {
  edgeIdx: number;
  edgeId: number;
  cornerIdx: number;   // snapped to nearest endpoint
  cornerX: number;
  cornerY: number;
  distPx: number;      // image-pixel distance
};

/** Find nearest border edge within `radiusPx` of (px, py).
 *  Returns the snap target (rounded to the nearest endpoint corner). */
export function findNearestEdge(g: EdgeGraph, px: number, py: number, radiusPx: number): Snap | null {
  const cs = g.cellSize;
  const cx = Math.floor(px / cs);
  const cy = Math.floor(py / cs);
  const rCells = Math.ceil(radiusPx / cs);
  const r2 = radiusPx * radiusPx;
  let bestD2 = r2;
  let bestE = -1;
  let bestT = 0;
  for (let dy = -rCells; dy <= rCells; dy++) {
    const ny = cy + dy;
    if (ny < 0 || ny >= g.gridH) continue;
    for (let dx = -rCells; dx <= rCells; dx++) {
      const nx = cx + dx;
      if (nx < 0 || nx >= g.gridW) continue;
      const bucket = g.grid[ny * g.gridW + nx];
      for (let i = 0; i < bucket.length; i++) {
        const e = bucket[i];
        const r = pointToSegment(px, py, g.ax[e], g.ay[e], g.bx[e], g.by[e]);
        if (r.d2 < bestD2) {
          bestD2 = r.d2;
          bestE = e;
          bestT = r.t;
        }
      }
    }
  }
  if (bestE < 0) return null;
  // Round to the closer endpoint
  const useA = bestT <= 0.5;
  const cornerX = useA ? g.ax[bestE] : g.bx[bestE];
  const cornerY = useA ? g.ay[bestE] : g.by[bestE];
  return {
    edgeIdx: bestE,
    edgeId: g.edgeIds[bestE],
    cornerIdx: cornerY * g.cornerW + cornerX,
    cornerX, cornerY,
    distPx: Math.sqrt(bestD2),
  };
}

/** BFS over the corner graph from `sourceCorner` to `targetCorner`.
 *  Returns the corner path (pixel-corner coords) or null if unreachable.
 *
 *  If `edgeId` is supplied, only edges with that id are traversable
 *  (path stays on one contour). If omitted, the whole border-edge grid
 *  is searched — including T-junction shortcuts — giving the shortest
 *  path by step count. */
export function pathAlongEdge(
  g: EdgeGraph, sourceCorner: number, targetCorner: number, edgeId?: number,
): { xs: Int32Array; ys: Int32Array } | null {
  if (sourceCorner === targetCorner) {
    const xs = new Int32Array(1);
    const ys = new Int32Array(1);
    ys[0] = Math.floor(sourceCorner / g.cornerW);
    xs[0] = sourceCorner - ys[0] * g.cornerW;
    return { xs, ys };
  }
  const parents = new Map<number, number>();
  parents.set(sourceCorner, -1);
  const queue: number[] = [sourceCorner];
  let found = false;
  for (let head = 0; head < queue.length && !found; head++) {
    const c = queue[head];
    const list = g.cornerToEdges.get(c);
    if (!list) continue;
    for (const eIdx of list) {
      if (edgeId !== undefined && g.edgeIds[eIdx] !== edgeId) continue;
      const ax = g.ax[eIdx], ay = g.ay[eIdx];
      const bx = g.bx[eIdx], by = g.by[eIdx];
      const ca = ay * g.cornerW + ax;
      const cb = by * g.cornerW + bx;
      const other = ca === c ? cb : ca;
      if (parents.has(other)) continue;
      parents.set(other, c);
      if (other === targetCorner) { found = true; break; }
      queue.push(other);
    }
  }
  if (!found) return null;
  // Walk back
  const cornersRev: number[] = [];
  let cur: number = targetCorner;
  while (cur !== -1) {
    cornersRev.push(cur);
    cur = parents.get(cur)!;
  }
  cornersRev.reverse();
  const xs = new Int32Array(cornersRev.length);
  const ys = new Int32Array(cornersRev.length);
  for (let i = 0; i < cornersRev.length; i++) {
    const cc = cornersRev[i];
    ys[i] = Math.floor(cc / g.cornerW);
    xs[i] = cc - ys[i] * g.cornerW;
  }
  return { xs, ys };
}


export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Encode the labels+phases as an opaque PNG and return its base64 payload
 *  (without the data: prefix), ready for the save endpoint. */
export async function maskToPngBase64(m: MaskData): Promise<string> {
  const c = document.createElement("canvas");
  c.width = m.width;
  c.height = m.height;
  c.getContext("2d")!.putImageData(renderMaskImageData(m), 0, 0);
  const dataUrl = c.toDataURL("image/png");
  return dataUrl.split(",", 2)[1];
}

export type BBox = { x0: number; y0: number; x1: number; y1: number };
export type ComponentsData = {
  ids: Uint32Array;            // per-pixel component id (1..count)
  bboxes: Map<number, BBox>;
  count: number;
};

/** 4-connected components on the labels array. ~50-200ms for 1MP. */
export function computeComponents(labels: Uint8Array, w: number, h: number): ComponentsData {
  const ids = new Uint32Array(w * h);
  const bboxes = new Map<number, BBox>();
  const queue = new Int32Array(w * h);
  let nextId = 1;

  for (let p0 = 0; p0 < w * h; p0++) {
    if (ids[p0] !== 0) continue;
    const lab = labels[p0];
    const id = nextId++;
    let head = 0, tail = 0;
    queue[tail++] = p0;
    ids[p0] = id;
    const yStart = (p0 / w) | 0;
    const xStart = p0 - yStart * w;
    let x0 = xStart, x1 = xStart, y0 = yStart, y1 = yStart;
    while (head < tail) {
      const p = queue[head++];
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      if (x > 0)     { const q = p - 1; if (ids[q] === 0 && labels[q] === lab) { ids[q] = id; queue[tail++] = q; } }
      if (x < w - 1) { const q = p + 1; if (ids[q] === 0 && labels[q] === lab) { ids[q] = id; queue[tail++] = q; } }
      if (y > 0)     { const q = p - w; if (ids[q] === 0 && labels[q] === lab) { ids[q] = id; queue[tail++] = q; } }
      if (y < h - 1) { const q = p + w; if (ids[q] === 0 && labels[q] === lab) { ids[q] = id; queue[tail++] = q; } }
    }
    bboxes.set(id, { x0, y0, x1, y1 });
  }
  return { ids, bboxes, count: nextId - 1 };
}

/** Mutate labels in place: every pixel whose component id equals `cid`
 *  gets the new label. Returns a fresh Uint8Array (immutable update). */
export function reassignComponent(
  labels: Uint8Array,
  components: ComponentsData,
  cid: number,
  newLabel: number,
): Uint8Array {
  const out = new Uint8Array(labels);
  const ids = components.ids;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === cid) out[i] = newLabel;
  }
  return out;
}
