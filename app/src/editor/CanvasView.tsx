import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ComponentsData, type MaskData, type Phase, type RGB, type Segments, type EdgeGraph, type Snap,
  parseMask, renderMaskImageData, computeEdgeData,
  findNearestEdge, pathAlongEdge, rgbToHex,
} from "./mask";
import { computeEdgeMap } from "./lasso/edges";
import { LassoEngine, pathFromParent } from "./lasso/lassoClient";
import type { Tool } from "./Toolbar";
import { ColorRangePanel } from "./ColorRangePanel";
import { PerfHud } from "./PerfHud";
import { recordPaint } from "./perf";

export type Mode = "preview" | "edit";

export type RegionClick = { cid: number; phaseIdx: number; x: number; y: number };
export type LassoCut = {
  /** w*h bool — which pixels were cut out. */
  cutMask: Uint8Array;
  /** Bounding box of cut pixels, image coords. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Original phase index of the cut area. */
  phaseIdx: number;
  /** Where to anchor the popup menu (screen coords). */
  x: number; y: number;
};

type Props = {
  id: string | null;
  /** Explicit image URLs (cloud): the photo under the outlines and the mask. */
  origSrc: string;
  maskSrc: string;
  /** Authoritative phase list (names + colours) for parsing the mask PNG. */
  phasesJson?: Phase[];
  mode: Mode;
  tool: Tool;
  spaceHeld: boolean;
  shiftHeld: boolean;
  mask: MaskData | null;
  components: ComponentsData | null;
  wandThreshold: number;                       // 0..100, colour tolerance
  onWandThreshold: (v: number) => void;
  wandFillArea: number;                        // max hole area to fill (0 = off)
  wandSmooth: number;                          // selection smoothing radius (0 = off)
  lassoThreshold: number;                      // 0..100, lasso snap-contrast floor
  onLassoThreshold: (v: number) => void;
  brushSize: number;                           // brush diameter, image px
  onBrushSize: (v: number) => void;
  targetPhaseIdx: number;                      // phase the brush paints with
  onTargetPhase: (i: number) => void;
  phases: Phase[];
  influenceOn: boolean;                        // restrict edits to allowed phases
  influenceAllowed: boolean[];                 // per phase index — editable?
  onMaskLoaded: (id: string, mask: MaskData, maskSource: string) => void;
  onRegionClick: (click: RegionClick | null) => void;
  onLassoCut: (cut: LassoCut) => void;
  onLassoBusyChange: (busy: boolean) => void;
};

const MASK_CANDIDATES = ["mask_edited.png", "mask_cleaned.png", "mask.png"];
const ORIG_CANDIDATES = ["orig.png", "orig.jpeg", "orig.jpg"];

// Screen-px slack baked around the viewport into the outline raster, so panning
// within this distance reuses the bake instead of re-stroking. Bigger = fewer
// re-strokes while panning, at the cost of a larger offscreen canvas.
const OUTLINE_MARGIN = 320;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed: ${url}`));
    img.src = url;
  });
}

async function loadFirst(id: string, names: string[]): Promise<{ img: HTMLImageElement; name: string } | null> {
  for (const name of names) {
    try { return { img: await loadImage(`/data/${id}/${name}`), name }; } catch {}
  }
  return null;
}

async function loadPhasesJson(id: string): Promise<Phase[] | undefined> {
  try {
    const r = await fetch(`/data/${id}/phases.json`);
    if (!r.ok) return undefined;
    const data = await r.json();
    if (Array.isArray(data?.phases)) return data.phases as Phase[];
    if (Array.isArray(data)) return data as Phase[];
  } catch {}
  return undefined;
}

type FitTransform = { dx: number; dy: number; scale: number; iw: number; ih: number };
type Pt = { x: number; y: number };

/** Build per-phase outline Path2Ds (image coords), with each border segment
 *  nudged inward by `1 / scale` image-px (≈1 screen px) along its normal —
 *  matching the original look. Cached by scale so panning reuses them. */
function buildOutlinePaths(segments: Segments, phaseCount: number, scale: number): Path2D[] {
  const inset = 1 / scale;
  const paths: Path2D[] = [];
  for (let p = 0; p < phaseCount; p++) {
    const arr = segments.perPhase[p];
    const path = new Path2D();
    for (let k = 0; k < arr.length; k += 6) {
      const nx = arr[k + 4], ny = arr[k + 5];
      path.moveTo(arr[k] + nx * inset, arr[k + 1] + ny * inset);
      path.lineTo(arr[k + 2] + nx * inset, arr[k + 3] + ny * inset);
    }
    paths.push(path);
  }
  return paths;
}

/** Fill enclosed non-selected components smaller than `maxArea` in a binary
 *  selection mask (1 = selected), in place — removes the speckle "holes" the
 *  magic wand leaves inside an otherwise solid region. 4-connected; a component
 *  touching the window border is the outside background and is never filled. */
function fillSmallHoles(sel: Uint8Array, w: number, h: number, maxArea: number) {
  const n = w * h;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const comp = new Int32Array(maxArea);   // remember pixels of small components
  for (let start = 0; start < n; start++) {
    if (sel[start] || visited[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; visited[start] = 1;
    let touchesBorder = false;
    let size = 0;
    while (head < tail) {
      const p = queue[head++];
      if (size < maxArea) comp[size] = p;
      size++;
      const y = (p / w) | 0, x = p - y * w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      if (x > 0)     { const q = p - 1; if (!sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (y > 0)     { const q = p - w; if (!sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (y < h - 1) { const q = p + w; if (!sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
    }
    if (!touchesBorder && size < maxArea) {
      for (let k = 0; k < size; k++) sel[comp[k]] = 1;
    }
  }
}

/** Smooth a binary selection (1 = selected) by a box-majority filter of the
 *  given radius, in place — Photoshop's "Smooth selection": each pixel takes the
 *  majority vote of the (2r+1)² box around it, which rounds jagged edges and
 *  wipes specks/holes up to ~r. O(n) via a summed-area table, any radius. */
function majoritySmooth(sel: Uint8Array, w: number, h: number, radius: number) {
  if (radius <= 0) return;
  const W1 = w + 1;
  const integ = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const iCur = (y + 1) * W1, iPrev = y * W1, sOff = y * w;
    for (let x = 0; x < w; x++) {
      rowSum += sel[sOff + x];
      integ[iCur + x + 1] = integ[iPrev + x + 1] + rowSum;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius > h - 1 ? h - 1 : y + radius;
    const top = y0 * W1, bot = (y1 + 1) * W1;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius > w - 1 ? w - 1 : x + radius;
      const sum = integ[bot + x1 + 1] - integ[bot + x0] - integ[top + x1 + 1] + integ[top + x0];
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[rowOff + x] = sum * 2 > area ? 1 : 0;   // strict majority selected
    }
  }
  sel.set(out);
}

/** Remove selected connected components smaller than `minArea` (4-connected),
 *  in place — drops the speckle "islands" a global colour selection leaves. */
function removeSmallIslands(sel: Uint8Array, w: number, h: number, minArea: number) {
  if (minArea <= 0) return;
  const n = w * h;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const comp = new Int32Array(minArea);   // remember pixels of small components
  for (let start = 0; start < n; start++) {
    if (!sel[start] || visited[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; visited[start] = 1;
    let size = 0;
    while (head < tail) {
      const p = queue[head++];
      if (size < minArea) comp[size] = p;
      size++;
      const y = (p / w) | 0, x = p - y * w;
      if (x > 0)     { const q = p - 1; if (sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (x < w - 1) { const q = p + 1; if (sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (y > 0)     { const q = p - w; if (sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      if (y < h - 1) { const q = p + w; if (sel[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
    }
    if (size < minArea) { for (let k = 0; k < size; k++) sel[comp[k]] = 0; }
  }
}

export function CanvasView({
  id, origSrc, maskSrc, phasesJson,
  mode, tool, spaceHeld, shiftHeld, mask, components,
  wandThreshold, onWandThreshold, wandFillArea, wandSmooth,
  lassoThreshold, onLassoThreshold,
  brushSize, onBrushSize, targetPhaseIdx, onTargetPhase, phases,
  influenceOn, influenceAllowed,
  onMaskLoaded, onRegionClick, onLassoCut, onLassoBusyChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [orig, setOrig] = useState<HTMLImageElement | null>(null);
  const [maskSource, setMaskSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [hoverCid, setHoverCid] = useState<number>(0);
  const fitRef = useRef<FitTransform | null>(null);
  // User-controlled view: zoom factor *on top of* fit-contain scale, and pan
  // offset in screen pixels added to the centred origin.
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  // Repaint without forcing a React re-render. Pan / zoom / lasso mutate refs
  // and call paint() directly, so we don't tear down + rebuild the whole draw
  // effect + ResizeObserver on every mouse-move tick. We paint *synchronously*
  // (not via requestAnimationFrame) because rAF is throttled to ~1 Hz in
  // backgrounded / embedded webviews, which would make dragging feel frozen.
  const drawRef = useRef<() => void>(() => {});
  const paint = useCallback(() => { drawRef.current(); }, []);
  // Cached per-phase outline Path2Ds, keyed by the scale they were built at.
  // The 1-screen-px inset depends on scale, so we rebuild only when the zoom
  // changes — panning reuses the cache, keeping the per-frame cost to just
  // stroking ready paths (no re-tracing the contour every frame).
  const outlineCacheRef = useRef<{ paths: Path2D[]; scale: number } | null>(null);
  // Rasterized outline layer: the stroked outlines baked into a viewport-sized
  // offscreen canvas. Stroking ~50k tiny border segments every frame is the
  // edit-mode viewport's main cost; instead we stroke once into this layer and
  // blit it 1:1 each frame. The stroke geometry depends only on `scale` (inset
  // and width are both screen-pixel-derived), so the layer is reused across
  // pans — we only re-stroke when the zoom changes, the mask changes, or the
  // pan drifts past the `OUTLINE_MARGIN` slack baked around the viewport. The
  // result is pixel-identical to stroking directly, just O(1) per frame.
  type OutlineLayer = {
    canvas: HTMLCanvasElement;
    scale: number; dpr: number;
    cssW: number; cssH: number;   // layer size incl. margin, css px
    dx: number; dy: number;       // image origin (screen px) at bake time
  };
  const outlineLayerRef = useRef<OutlineLayer | null>(null);
  // Cached canvas backing-store size. Re-applied only when it actually changes:
  // assigning canvas.width/height clears + reallocates the bitmap, which is far
  // too costly to do on every frame.
  const viewportRef = useRef({ w: 0, h: 0, dpr: 1 });
  const syncSize = useCallback(() => {
    const c = canvasRef.current, wrap = wrapRef.current;
    if (!c || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const vp = viewportRef.current;
    if (vp.w === w && vp.h === h && vp.dpr === dpr) return;
    vp.w = w; vp.h = h; vp.dpr = dpr;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }, []);
  // Drag state for pan (right or middle mouse button).
  const panRef = useRef<{ startX: number; startY: number; basePanX: number; basePanY: number; moved: boolean } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // Off-screen opaque mask bitmap (for preview + space-peek + save).
  const maskBitmapRef = useRef<HTMLCanvasElement | null>(null);
  // Border segments per phase, image coords + inward normals (for outlines).
  const segmentsRef = useRef<Segments | null>(null);
  // Full edge graph (for snap + path-along-edge).
  const edgeGraphRef = useRef<EdgeGraph | null>(null);

  // ---------------- Lasso state ----------------
  const lassoEngineRef = useRef<LassoEngine | null>(null);
  const edgeReadyRef = useRef(false);
  // Seeds remember whether they're snapped to the edge grid (cornerIdx).
  type SeedPt = { x: number; y: number; cornerIdx: number | null };
  const [seeds, setSeeds] = useState<SeedPt[]>([]);
  const seedsRef = useRef<SeedPt[]>([]);
  seedsRef.current = seeds;
  // Current snap state — set on every mouse-move while the lasso tool is active.
  const currentSnapRef = useRef<Snap | null>(null);
  // committed path points (image coords). Each segment is appended on click.
  const committedPathRef = useRef<Pt[]>([]);
  // Cached hover-highlight bitmap, keyed by component id, so panning over a
  // hovered region doesn't re-rasterize its whole bbox each frame.
  const hoverOverlayRef = useRef<{ cid: number; canvas: HTMLCanvasElement; x0: number; y0: number } | null>(null);
  // current parent map (from latest seed)
  const currentParentRef = useRef<Int32Array | null>(null);
  // seq of the latest dispatched dijkstra request — ignore stale returns
  const latestParentSeqRef = useRef(0);
  // cursor in image coords (for tail rendering)
  const cursorRef = useRef<Pt | null>(null);
  // class under the very first seed — the phase we're cutting from
  const cutPhaseIdxRef = useRef<number | null>(null);
  // Preview-parent recompute is coalesced: at most one worker request in
  // flight; if the cursor moves again meanwhile, we re-run once it returns.
  const parentBusyRef = useRef(false);
  const parentDirtyRef = useRef(false);

  // ---------------- Magic wand state ----------------
  // Latest minimax cost map (edge-barrier flood) from the hovered seed.
  const wandCostRef = useRef<{ cost: Uint8Array; x0: number; y0: number; x1: number; y1: number; seedX: number; seedY: number; phaseIdx: number } | null>(null);
  // Cached purple preview overlay, rebuilt only when the selection mask changes.
  const wandOverlayRef = useRef<{ canvas: HTMLCanvasElement; sel: Uint8Array } | null>(null);
  // Cached binary selection mask (1 = selected) over the wand window, with small
  // holes optionally filled. Shared by the preview overlay and the click cut so
  // both show exactly the same shape. Keyed by (threshold, cost map, fill).
  const wandSelRef = useRef<{ sel: Uint8Array; winW: number; winH: number; thr: number; cost: Uint8Array; fillArea: number; smooth: number } | null>(null);
  const wandBusyRef = useRef(false);
  const wandDirtyRef = useRef(false);
  const wandSeqRef = useRef(0);
  const wandHoverRef = useRef<Pt | null>(null);   // pixel currently hovered
  // Live mirrors so the (stable) wheel handler can read current tool/threshold.
  const toolRef = useRef(tool); toolRef.current = tool;
  const wandThreshRef = useRef(wandThreshold); wandThreshRef.current = wandThreshold;
  const onWandThresholdRef = useRef(onWandThreshold); onWandThresholdRef.current = onWandThreshold;
  const lassoThreshRef = useRef(lassoThreshold); lassoThreshRef.current = lassoThreshold;
  const onLassoThresholdRef = useRef(onLassoThreshold); onLassoThresholdRef.current = onLassoThreshold;
  // Set after recomputePreview is defined; lets the (stable) wheel handler
  // refresh the live-wire tail when the snap contrast changes mid-trace.
  const recomputePreviewRef = useRef<() => void>(() => {});

  // ---------------- Brush state ----------------
  // Live mirrors read by the brush stamp / wheel / paint-stroke listeners,
  // which are set up once and must see the latest props without re-binding.
  const maskRef = useRef(mask); maskRef.current = mask;
  const brushSizeRef = useRef(brushSize); brushSizeRef.current = brushSize;
  const onBrushSizeRef = useRef(onBrushSize); onBrushSizeRef.current = onBrushSize;
  const targetPhaseIdxRef = useRef(targetPhaseIdx); targetPhaseIdxRef.current = targetPhaseIdx;
  const influenceOnRef = useRef(influenceOn); influenceOnRef.current = influenceOn;
  const influenceAllowedRef = useRef(influenceAllowed); influenceAllowedRef.current = influenceAllowed;
  const onLassoCutRef = useRef(onLassoCut); onLassoCutRef.current = onLassoCut;
  // Brush cursor (image coords) for the size ring.
  const brushHoverRef = useRef<Pt | null>(null);
  // Live stroke: an image-sized overlay canvas painted in the target colour,
  // plus the boolean cut mask + bbox it builds up. Committed (via onLassoCut)
  // on mouse-up and cleared once the resulting mask change lands.
  const strokeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeImgRef = useRef<ImageData | null>(null);
  const strokeMaskRef = useRef<Uint8Array | null>(null);
  const strokeBBoxRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const strokeHasContentRef = useRef(false);
  const paintingRef = useRef(false);
  const lastPaintPtRef = useRef<Pt | null>(null);
  const [isPainting, setIsPainting] = useState(false);
  // Brush clip for the colour-range brush mode: set at stroke start to the
  // current colour-range selection; the plain brush tool leaves it null (free).
  const strokeClipRef = useRef<Uint8Array | null>(null);

  // ---------------- Colour-range state ----------------
  // Original image colours at mask resolution (for sampling + the global
  // colour-membership selection). Rebuilt per image, not on every edit.
  const [origRgb, setOrigRgb] = useState<{ rgb: Uint8Array; w: number; h: number } | null>(null);
  const [crInclude, setCrInclude] = useState<RGB[]>([]);
  const [crExclude, setCrExclude] = useState<RGB[]>([]);
  const [crTolerance, setCrTolerance] = useState(15);      // persists across images
  // Selection cleanup (persist across images): cut islands ≤ N px, fill holes
  // ≤ N px, smooth the edge by radius. All applied after colour membership.
  const [crMinArea, setCrMinArea] = useState(4);
  const [crFillArea, setCrFillArea] = useState(4);
  const [crSmooth, setCrSmooth] = useState(1);
  // Colour-range sub-tool: two eyedroppers + an in-panel brush mode.
  const [crMode, setCrMode] = useState<"plus" | "minus" | "brush">("plus");
  const [crCount, setCrCount] = useState(0);
  const crSelRef = useRef<{ sel: Uint8Array; w: number; h: number } | null>(null);
  const crOverlayRef = useRef<{ canvas: HTMLCanvasElement; sel: Uint8Array } | null>(null);
  const origRgbRef = useRef(origRgb); origRgbRef.current = origRgb;
  const crModeRef = useRef(crMode); crModeRef.current = crMode;

  const cancelLasso = useCallback(() => {
    setSeeds([]);
    committedPathRef.current = [];
    currentParentRef.current = null;
    latestParentSeqRef.current += 1;
    cursorRef.current = null;
    cutPhaseIdxRef.current = null;
    currentSnapRef.current = null;
    paint();
  }, [paint]);

  // Reload orig+mask from the given URLs; rebuild edge map / cancel lasso.
  useEffect(() => {
    cancelLasso();
    // Reset view when switching images.
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    if (!id || !origSrc || !maskSrc) { setOrig(null); setError(null); setMaskSource(""); return; }
    let cancelled = false;
    setError(null);
    (async () => {
      let origImg: HTMLImageElement, maskImg: HTMLImageElement;
      try {
        [origImg, maskImg] = await Promise.all([loadImage(origSrc), loadImage(maskSrc)]);
      } catch {
        if (!cancelled) setError("не удалось загрузить фото/маску");
        return;
      }
      if (cancelled) return;
      setOrig(origImg);
      setMaskSource("mask");
      const parsed = parseMask(maskImg, phasesJson);
      onMaskLoaded(id, parsed, "mask");

      // Build edge map asynchronously so it doesn't block the first render.
      // Work in mask resolution so live-wire coords match the mask/edge-graph
      // even when the original image has a different size.
      edgeReadyRef.current = false;
      setTimeout(() => {
        if (cancelled) return;
        const { grad, rgb, w, h } = computeEdgeMap(origImg, parsed.width, parsed.height);
        if (cancelled) return;
        if (!lassoEngineRef.current) lassoEngineRef.current = new LassoEngine();
        lassoEngineRef.current.setEdgeMap(grad, rgb, w, h);
        edgeReadyRef.current = true;
      }, 0);
    })();
    return () => { cancelled = true; };
  }, [id, origSrc, maskSrc, phasesJson, onMaskLoaded, cancelLasso]);

  // Dispose worker on unmount
  useEffect(() => () => { lassoEngineRef.current?.dispose(); }, []);

  useEffect(() => {
    hoverOverlayRef.current = null;
    outlineCacheRef.current = null;   // outlines/colors changed → rebuild
    outlineLayerRef.current = null;   // baked outline raster is stale
    clearStroke();                    // a committed brush stroke is now in `mask`
    if (!mask) {
      maskBitmapRef.current = null;
      segmentsRef.current = null;
      return;
    }
    const opaque = document.createElement("canvas");
    opaque.width = mask.width;
    opaque.height = mask.height;
    opaque.getContext("2d")!.putImageData(renderMaskImageData(mask), 0, 0);
    maskBitmapRef.current = opaque;
    const { graph, segments } = computeEdgeData(mask);
    edgeGraphRef.current = graph;
    segmentsRef.current = segments;
  }, [mask]);

  // Sample the original image at mask resolution for colour-range work. Depends
  // on the image + dimensions only — not on every label edit.
  useEffect(() => {
    if (!orig || !mask) { setOrigRgb(null); return; }
    const w = mask.width, h = mask.height;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(orig, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    }
    setOrigRgb({ rgb, w, h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orig, mask?.width, mask?.height]);

  // Colour samples are image-specific — drop them when the image changes.
  useEffect(() => {
    setCrInclude([]); setCrExclude([]); setCrCount(0);
    crSelRef.current = null; crOverlayRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Global colour-membership selection: a pixel is in when its colour is within
  // `tolerance` of an include sample and not within tolerance of any exclude.
  useEffect(() => {
    const data = origRgb;
    if (!data || crInclude.length === 0) {
      crSelRef.current = null; crOverlayRef.current = null;
      setCrCount(0); paint();
      return;
    }
    const { rgb, w, h } = data;
    const n = w * h;
    const tol = Math.round((crTolerance / 100) * 255);
    const inc = crInclude, exc = crExclude;
    const sel = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 3, r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      let dmin = 999;
      for (let k = 0; k < inc.length; k++) {
        const c = inc[k];
        const d = Math.max(Math.abs(r - c[0]), Math.abs(g - c[1]), Math.abs(b - c[2]));
        if (d < dmin) { dmin = d; if (dmin === 0) break; }
      }
      if (dmin > tol) continue;
      let excluded = false;
      for (let k = 0; k < exc.length; k++) {
        const c = exc[k];
        const d = Math.max(Math.abs(r - c[0]), Math.abs(g - c[1]), Math.abs(b - c[2]));
        if (d <= tol) { excluded = true; break; }
      }
      if (excluded) continue;
      sel[i] = 1;
    }
    // Cleanup: drop tiny islands ≤ N px, fill holes ≤ N px, then smooth the edge.
    if (crMinArea > 0) removeSmallIslands(sel, w, h, crMinArea + 1);
    if (crFillArea > 0) fillSmallHoles(sel, w, h, crFillArea + 1);
    if (crSmooth > 0) majoritySmooth(sel, w, h, crSmooth);
    let count = 0;
    for (let i = 0; i < n; i++) if (sel[i]) count++;
    crSelRef.current = { sel, w, h };
    crOverlayRef.current = null;
    setCrCount(count);
    paint();
  }, [origRgb, crInclude, crExclude, crTolerance, crMinArea, crFillArea, crSmooth, paint]);

  const screenToImage = (clientX: number, clientY: number): Pt | null => {
    const wrap = wrapRef.current;
    const fit = fitRef.current;
    if (!wrap || !fit) return null;
    const rect = wrap.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const x = Math.floor((sx - fit.dx) / fit.scale);
    const y = Math.floor((sy - fit.dy) / fit.scale);
    if (x < 0 || y < 0 || x >= fit.iw || y >= fit.ih) return null;
    return { x, y };
  };
  const imageToScreen = (imgX: number, imgY: number): Pt | null => {
    const wrap = wrapRef.current;
    const fit = fitRef.current;
    if (!wrap || !fit) return null;
    const rect = wrap.getBoundingClientRect();
    return {
      x: rect.left + fit.dx + (imgX + 0.5) * fit.scale,
      y: rect.top + fit.dy + (imgY + 0.5) * fit.scale,
    };
  };
  // Continuous, *unclamped* image coords — used for snapping and lasso seeds so
  // the cursor can reach the image frame (corner coords run up to w / h, one
  // past the last pixel) and snap with sub-pixel accuracy. Only null when there
  // is no active fit transform yet.
  const screenToImageF = (clientX: number, clientY: number): Pt | null => {
    const wrap = wrapRef.current;
    const fit = fitRef.current;
    if (!wrap || !fit) return null;
    const rect = wrap.getBoundingClientRect();
    return {
      x: (clientX - rect.left - fit.dx) / fit.scale,
      y: (clientY - rect.top - fit.dy) / fit.scale,
    };
  };

  const cidAt = (imgX: number, imgY: number): number => {
    if (!mask || !components) return 0;
    return components.ids[imgY * mask.width + imgX];
  };

  // The wand selection over its window: {cost ≤ threshold}, optionally with
  // tiny enclosed holes filled. Cached by (threshold, cost map, fill) so the
  // preview overlay and the click-to-cut share one result and panning is free.
  const wandSelection = (): { sel: Uint8Array; winW: number; winH: number; x0: number; y0: number } | null => {
    const wc = wandCostRef.current;
    if (!wc) return null;
    const L8 = Math.round((wandThreshold / 100) * 255);
    const fillArea = wandFillArea, smooth = wandSmooth;
    const cached = wandSelRef.current;
    if (cached && cached.thr === L8 && cached.cost === wc.cost
        && cached.fillArea === fillArea && cached.smooth === smooth) {
      return { sel: cached.sel, winW: cached.winW, winH: cached.winH, x0: wc.x0, y0: wc.y0 };
    }
    const winW = wc.x1 - wc.x0 + 1, winH = wc.y1 - wc.y0 + 1;
    const sel = new Uint8Array(winW * winH);
    const cost = wc.cost;
    for (let i = 0; i < cost.length; i++) sel[i] = cost[i] <= L8 ? 1 : 0;
    // Fill enclosed holes up to `fillArea` px, then round the edge by `smooth`.
    if (fillArea > 0) fillSmallHoles(sel, winW, winH, fillArea + 1);
    if (smooth > 0) majoritySmooth(sel, winW, winH, smooth);
    wandSelRef.current = { sel, winW, winH, thr: L8, cost: wc.cost, fillArea, smooth };
    return { sel, winW, winH, x0: wc.x0, y0: wc.y0 };
  };

  // -------- Draw routine --------
  // The draw closure is rebuilt only when the React state it reads changes;
  // pan / zoom / lasso (which only mutate refs) repaint by calling paint()
  // directly, without a React re-render.
  useEffect(() => {
    drawRef.current = () => {
      const _t0 = performance.now();
      try {
      const c = canvasRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap) return;
      syncSize();
      const { w, h, dpr } = viewportRef.current;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      if (!orig || !mask) { fitRef.current = null; return; }

      // Work in mask coordinates everywhere (labels, components, edge graph and
      // lasso all live there). The original is just stretched onto the same
      // area, so a different-resolution orig with the same aspect ratio lines
      // up pixel-for-pixel with the mask.
      const iw = mask.width;
      const ih = mask.height;
      const fitScale = Math.min(w / iw, h / ih);
      const scale = fitScale * viewRef.current.zoom;
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (w - dw) / 2 + viewRef.current.panX;
      const dy = (h - dh) / 2 + viewRef.current.panY;
      fitRef.current = { dx, dy, scale, iw, ih };

      // Base layer:
      // preview      → mask (Space-peek → orig)
      // edit         → orig + vector outlines (Space-peek → mask)
      // The original is drawn smoothed (it may be stretched from a smaller
      // resolution); the mask is drawn nearest-neighbour to keep class colours
      // and boundaries crisp.
      const bitmap = maskBitmapRef.current;
      const drawOrig = () => {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(orig, dx, dy, dw, dh);
        ctx.imageSmoothingEnabled = false;
      };
      // Shift+Space with the wand is a "hide the overlay" gesture only — it must
      // NOT trigger the Space mask-peek, so suppress peeking in that case.
      const wandHideGesture = mode === "edit" && tool === "wand" && spaceHeld && shiftHeld;
      const crHideGesture = mode === "edit" && tool === "colorrange" && spaceHeld && shiftHeld;
      const peek = spaceHeld && !wandHideGesture && !crHideGesture;
      if (mode === "preview") {
        if (peek) drawOrig();
        else if (bitmap) ctx.drawImage(bitmap, dx, dy, dw, dh);
      } else {
        if (peek) {
          if (bitmap) ctx.drawImage(bitmap, dx, dy, dw, dh);
        } else {
          drawOrig();
          // Vector outlines, drawn in screen space so they stay crisp at any
          // zoom. The Path2Ds are cached and only rebuilt when the scale
          // changes (the inset is scale-dependent), so panning just strokes
          // ready paths.
          const segs = segmentsRef.current;
          if (segs) {
            let oc = outlineCacheRef.current;
            if (!oc || oc.scale !== scale) {
              oc = { paths: buildOutlinePaths(segs, mask.phases.length, scale), scale };
              outlineCacheRef.current = oc;
            }
            // Bake the stroked outlines into a viewport-sized offscreen layer
            // and blit that, instead of re-stroking tens of thousands of tiny
            // segments every frame. Re-bake only when the zoom changes or the
            // pan drifts past the margin slack — plain pans just re-blit.
            const M = OUTLINE_MARGIN;
            const cssW = w + 2 * M, cssH = h + 2 * M;
            const prev = outlineLayerRef.current;
            const stale =
              !prev || prev.scale !== scale || prev.dpr !== dpr ||
              prev.cssW !== cssW || prev.cssH !== cssH ||
              Math.abs(dx - prev.dx) > M || Math.abs(dy - prev.dy) > M;
            let layer: OutlineLayer;
            if (stale) {
              const lc = prev?.canvas ?? document.createElement("canvas");
              const pxW = Math.round(cssW * dpr), pxH = Math.round(cssH * dpr);
              if (lc.width !== pxW) lc.width = pxW;
              if (lc.height !== pxH) lc.height = pxH;
              const lctx = lc.getContext("2d")!;
              lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              lctx.clearRect(0, 0, cssW, cssH);
              // Same transform as the direct path, shifted by the margin so the
              // baked raster has slack on every side for small pans.
              lctx.translate(dx + M, dy + M);
              lctx.scale(scale, scale);
              lctx.lineCap = "square";
              lctx.lineWidth = 2 / scale;      // constant ~2 screen px
              for (let p = 0; p < mask.phases.length; p++) {
                lctx.strokeStyle = rgbToHex(mask.phases[p].color);
                lctx.stroke(oc.paths[p]);
              }
              layer = { canvas: lc, scale, dpr, cssW, cssH, dx, dy };
              outlineLayerRef.current = layer;
            } else {
              layer = prev!;
            }
            // Blit 1:1 in device pixels (identity transform, no smoothing) so
            // there's no resampling — the result matches a direct stroke. The
            // pan offset since bake time is applied as an integer-px shift.
            const offX = Math.round((dx - layer.dx - M) * dpr);
            const offY = Math.round((dy - layer.dy - M) * dpr);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(layer.canvas, offX, offY);
            ctx.restore();
          }
        }
      }

      // Hover highlight — both modes, suppressed while Space-peeking and
      // while the lasso tool is active. The overlay bitmap is rasterized once
      // per hovered component and cached, so panning doesn't redo it each frame.
      if (hoverCid && components && !spaceHeld && tool !== "lasso") {
        let ov = hoverOverlayRef.current;
        if (!ov || ov.cid !== hoverCid) {
          const bb = components.bboxes.get(hoverCid);
          if (bb) {
            const bw = bb.x1 - bb.x0 + 1;
            const bh = bb.y1 - bb.y0 + 1;
            const overlayBuf = new Uint8ClampedArray(bw * bh * 4);
            for (let y = 0; y < bh; y++) {
              for (let x = 0; x < bw; x++) {
                const p = (bb.y0 + y) * mask.width + (bb.x0 + x);
                if (components.ids[p] === hoverCid) {
                  const off = (y * bw + x) * 4;
                  overlayBuf[off] = 255; overlayBuf[off + 1] = 255;
                  overlayBuf[off + 2] = 255; overlayBuf[off + 3] = 80;
                }
              }
            }
            const tmp = document.createElement("canvas");
            tmp.width = bw; tmp.height = bh;
            tmp.getContext("2d")!.putImageData(new ImageData(overlayBuf, bw, bh), 0, 0);
            ov = { cid: hoverCid, canvas: tmp, x0: bb.x0, y0: bb.y0 };
          } else {
            ov = null;
          }
          hoverOverlayRef.current = ov;
        }
        if (ov) {
          ctx.drawImage(
            ov.canvas,
            dx + ov.x0 * scale, dy + ov.y0 * scale,
            ov.canvas.width * scale, ov.canvas.height * scale,
          );
        }
      }

      // Magic-wand preview — purple overlay of {cost ≤ threshold}. Rebuilt only
      // when the cost map or threshold changes; just blitted while panning.
      // Hidden by the Shift+Space gesture so you can peek at the original under
      // the selection (Shift alone stays free for Shift+wheel threshold tweaks).
      if (tool === "wand" && !wandHideGesture) {
        const selRes = wandSelection();
        if (selRes) {
          const { sel, winW, winH, x0: sx0, y0: sy0 } = selRes;
          let ov = wandOverlayRef.current;
          if (!ov || ov.sel !== sel) {
            const buf = new Uint8ClampedArray(winW * winH * 4);
            for (let i = 0; i < sel.length; i++) {
              if (sel[i]) {
                const o = i * 4;
                buf[o] = 168; buf[o + 1] = 85; buf[o + 2] = 247; buf[o + 3] = 120;
              }
            }
            const tmp = document.createElement("canvas");
            tmp.width = winW; tmp.height = winH;
            tmp.getContext("2d")!.putImageData(new ImageData(buf, winW, winH), 0, 0);
            ov = { canvas: tmp, sel };
            wandOverlayRef.current = ov;
          }
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            ov.canvas,
            dx + sx0 * scale, dy + sy0 * scale,
            ov.canvas.width * scale, ov.canvas.height * scale,
          );
        }
      }

      // Colour-range preview — purple overlay of the global colour selection.
      // Hidden by Shift+Space (peek the original) like the wand.
      if (mode === "edit" && tool === "colorrange" && !crHideGesture) {
        const cr = crSelRef.current;
        if (cr) {
          let ov = crOverlayRef.current;
          if (!ov || ov.sel !== cr.sel) {
            const buf = new Uint8ClampedArray(cr.w * cr.h * 4);
            for (let i = 0; i < cr.sel.length; i++) {
              if (cr.sel[i]) {
                const o = i * 4;
                buf[o] = 168; buf[o + 1] = 85; buf[o + 2] = 247; buf[o + 3] = 120;
              }
            }
            const tmp = document.createElement("canvas");
            tmp.width = cr.w; tmp.height = cr.h;
            tmp.getContext("2d")!.putImageData(new ImageData(buf, cr.w, cr.h), 0, 0);
            ov = { canvas: tmp, sel: cr.sel };
            crOverlayRef.current = ov;
          }
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(ov.canvas, dx, dy, iw * scale, ih * scale);
        }
      }

      // Brush: live stroke overlay (target colour) + size ring under cursor.
      // Active for the brush tool and the colour-range in-panel brush mode.
      if (mode === "edit" && (tool === "brush" || (tool === "colorrange" && crMode === "brush"))) {
        const sc = strokeCanvasRef.current;
        if (sc && strokeHasContentRef.current) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sc, dx, dy, iw * scale, ih * scale);
        }
        const hp = brushHoverRef.current;
        if (hp) {
          const rr = Math.max(0.5, brushSize / 2) * scale;
          const cxp = dx + (hp.x + 0.5) * scale;
          const cyp = dy + (hp.y + 0.5) * scale;
          ctx.beginPath();
          ctx.arc(cxp, cyp, rr, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(cxp, cyp, rr, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Lasso visuals
      if (tool === "lasso") {
        const drawPolyline = (pts: Pt[], style: string, width: number) => {
          if (pts.length < 2) return;
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();
          // Lasso points are pixel-corner coords → lie exactly on grid lines
          // (no +0.5 pixel-centre offset).
          ctx.moveTo(dx + pts[0].x * scale, dy + pts[0].y * scale);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(dx + pts[i].x * scale, dy + pts[i].y * scale);
          }
          ctx.stroke();
        };
        // committed segments (yellow)
        drawPolyline(committedPathRef.current, "rgba(255, 215, 64, 0.95)", 1.5);
        // Snap highlight — every edge sharing the snapped contour
        // (same edgeId) gets drawn thicker so the user sees what they
        // can snap to. Path BFS, however, is NOT restricted to this
        // edgeId; it freely shortcuts through T-junctions.
        const snap = currentSnapRef.current;
        const eg = edgeGraphRef.current;
        if (snap && eg) {
          ctx.save();
          ctx.translate(dx, dy);
          ctx.scale(scale, scale);
          ctx.lineCap = "round";
          ctx.strokeStyle = "rgba(76, 220, 255, 0.85)";
          ctx.lineWidth = 3 / scale;
          ctx.beginPath();
          for (let i = 0; i < eg.count; i++) {
            if (eg.edgeIds[i] === snap.edgeId) {
              ctx.moveTo(eg.ax[i], eg.ay[i]);
              ctx.lineTo(eg.bx[i], eg.by[i]);
            }
          }
          ctx.stroke();
          ctx.restore();
        }

        // Tail from latest seed → cursor (cyan).
        const tail: Pt[] = [];
        const prev = seedsRef.current[seedsRef.current.length - 1] as SeedPt | undefined;
        const cur = snap
          ? { x: snap.cornerX, y: snap.cornerY }
          : cursorRef.current;
        // Edge-grid path preview when BOTH ends are snapped.
        let drewEdgePreview = false;
        if (snap && eg && prev && prev.cornerIdx !== null) {
          const ep = pathAlongEdge(eg, prev.cornerIdx, snap.cornerIdx);
          if (ep) {
            for (let i = 0; i < ep.xs.length; i++) tail.push({ x: ep.xs[i], y: ep.ys[i] });
            drewEdgePreview = true;
          }
        }
        if (!drewEdgePreview) {
          const parent = currentParentRef.current;
          if (cur && parent && seedsRef.current.length > 0) {
            const cx = Math.max(0, Math.min(iw, cur.x));
            const cy = Math.max(0, Math.min(ih, cur.y));
            const path = pathFromParent(parent, iw + 1, cx, cy);
            if (path) {
              for (let i = path.xs.length - 1; i >= 0; i--) tail.push({ x: path.xs[i], y: path.ys[i] });
            }
          }
        }
        drawPolyline(tail, "rgba(76, 179, 255, 0.95)", 1.5);

        // Snap marker dot.
        if (snap) {
          const mx = dx + snap.cornerX * scale;
          const my = dy + snap.cornerY * scale;
          ctx.beginPath();
          ctx.arc(mx, my, 4, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(76, 220, 255, 1)";
          ctx.fill();
        }

        // seed dots (corner coords → on grid lines)
        ctx.fillStyle = "rgba(255, 215, 64, 1)";
        for (const s of seedsRef.current) {
          ctx.beginPath();
          ctx.arc(dx + s.x * scale, dy + s.y * scale, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        // Close-hint ring around the first seed when cursor is near.
        const s0 = seedsRef.current[0];
        if (s0 && seedsRef.current.length >= 2 && cur) {
          const dxi = cur.x - s0.x, dyi = cur.y - s0.y;
          const near = Math.sqrt(dxi * dxi + dyi * dyi) <= closeRadiusImage();
          ctx.beginPath();
          ctx.arc(
            dx + s0.x * scale,
            dy + s0.y * scale,
            CLOSE_RADIUS_SCREEN,
            0, Math.PI * 2,
          );
          ctx.strokeStyle = near ? "rgba(76, 220, 130, 1)" : "rgba(255, 215, 64, 0.65)";
          ctx.lineWidth = near ? 2.5 : 1.5;
          ctx.stroke();
          if (near) {
            ctx.fillStyle = "rgba(76, 220, 130, 0.22)";
            ctx.fill();
          }
        }
      }
      } finally {
        recordPaint(performance.now() - _t0);
      }
    };
    // Repaint on any structural change (image / mode / mask / hover / wand / brush).
    drawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orig, mask, components, mode, tool, spaceHeld, shiftHeld, hoverCid, wandThreshold, wandFillArea, wandSmooth, brushSize, crMode]);

  // ResizeObserver + initial paint — set up once, independent of redraws.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    syncSize();
    drawRef.current();
    const ro = new ResizeObserver(() => { syncSize(); drawRef.current(); });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
    };
  }, [syncSize]);

  // Cancel lasso when leaving edit or lasso tool.
  useEffect(() => {
    if (mode !== "edit" || tool !== "lasso") cancelLasso();
  }, [mode, tool, cancelLasso]);

  // Clear the wand preview when leaving edit or the wand tool.
  const clearWand = useCallback(() => {
    wandCostRef.current = null;
    wandOverlayRef.current = null;
    wandSelRef.current = null;
    wandSeqRef.current += 1;
    paint();
  }, [paint]);
  useEffect(() => {
    if (mode !== "edit" || tool !== "wand") clearWand();
  }, [mode, tool, clearWand]);

  // ---------------- Brush painting ----------------
  // Cursor → image pixel, clamped to the image so edge strokes still register.
  const imgPixelClamped = (clientX: number, clientY: number): Pt | null => {
    const fp = screenToImageF(clientX, clientY);
    const m = maskRef.current;
    if (!fp || !m) return null;
    return {
      x: Math.max(0, Math.min(m.width - 1, Math.floor(fp.x))),
      y: Math.max(0, Math.min(m.height - 1, Math.floor(fp.y))),
    };
  };

  const ensureStrokeBuffers = (): HTMLCanvasElement | null => {
    const m = maskRef.current;
    if (!m) return null;
    let sc = strokeCanvasRef.current;
    if (!sc || sc.width !== m.width || sc.height !== m.height) {
      sc = document.createElement("canvas");
      sc.width = m.width; sc.height = m.height;
      strokeCanvasRef.current = sc;
      strokeImgRef.current = new ImageData(m.width, m.height);
    }
    return sc;
  };

  const clearStroke = () => {
    const sc = strokeCanvasRef.current;
    if (sc) sc.getContext("2d")!.clearRect(0, 0, sc.width, sc.height);
    if (strokeImgRef.current) strokeImgRef.current.data.fill(0);
    strokeMaskRef.current = null;
    strokeBBoxRef.current = null;
    strokeHasContentRef.current = false;
    lastPaintPtRef.current = null;
  };

  // Stamp a hard disc of the target colour at (cx, cy), skipping pixels already
  // stamped this stroke and (when influence is on) pixels in a protected phase.
  const stampDisc = (cx: number, cy: number) => {
    const m = maskRef.current;
    const sc = ensureStrokeBuffers();
    const img = strokeImgRef.current;
    if (!m || !sc || !img) return;
    let sm = strokeMaskRef.current;
    if (!sm) { sm = new Uint8Array(m.width * m.height); strokeMaskRef.current = sm; }
    const data = img.data;
    const colour = m.phases[targetPhaseIdxRef.current]?.color ?? [255, 0, 255];
    const tr = colour[0], tg = colour[1], tb = colour[2];
    const infOn = influenceOnRef.current;
    const allowed = influenceAllowedRef.current;
    const clip = strokeClipRef.current;
    const w = m.width, h = m.height;
    const r = Math.max(0.5, brushSizeRef.current / 2);
    const r2 = r * r;
    const ri = Math.ceil(r);
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let dy = -ri; dy <= ri; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        const i = yy * w + xx;
        if (sm[i]) continue;
        if (infOn && !(allowed[m.labels[i]] ?? true)) continue;
        if (clip && !clip[i]) continue;       // brush limited to colour-range sel
        sm[i] = 1;
        const o = i * 4;
        data[o] = tr; data[o + 1] = tg; data[o + 2] = tb; data[o + 3] = 255;
        if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx;
        if (yy < by0) by0 = yy; if (yy > by1) by1 = yy;
        strokeHasContentRef.current = true;
      }
    }
    if (bx1 >= 0) {
      sc.getContext("2d")!.putImageData(img, 0, 0, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1);
      const bb = strokeBBoxRef.current;
      strokeBBoxRef.current = bb
        ? { x0: Math.min(bb.x0, bx0), y0: Math.min(bb.y0, by0), x1: Math.max(bb.x1, bx1), y1: Math.max(bb.y1, by1) }
        : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    }
  };

  // Stamp along the segment from the previous point so fast drags leave no gaps.
  const paintTo = (pt: Pt) => {
    const last = lastPaintPtRef.current;
    const step = Math.max(1, (brushSizeRef.current / 2) * 0.5);
    if (!last) {
      stampDisc(pt.x, pt.y);
    } else {
      const dx = pt.x - last.x, dy = pt.y - last.y;
      const dist = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        stampDisc(Math.round(last.x + dx * t), Math.round(last.y + dy * t));
      }
    }
    lastPaintPtRef.current = pt;
    paint();
  };

  // Window-level move/up while painting: covers fast drags that leave the
  // canvas and the release that ends (and commits) the stroke.
  useEffect(() => {
    if (!isPainting) return;
    const move = (e: MouseEvent) => {
      const p = imgPixelClamped(e.clientX, e.clientY);
      if (p) paintTo(p);
      brushHoverRef.current = p;
    };
    const up = () => {
      paintingRef.current = false;
      setIsPainting(false);
      const sm = strokeMaskRef.current;
      const bb = strokeBBoxRef.current;
      const m = maskRef.current;
      if (sm && bb && strokeHasContentRef.current && m) {
        const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
        const screen = imageToScreen(cx, cy) ?? { x: 0, y: 0 };
        // Commit; the overlay is cleared by the mask-change effect once it lands.
        onLassoCutRef.current({ cutMask: sm, bbox: bb, phaseIdx: targetPhaseIdxRef.current, x: screen.x, y: screen.y });
      } else {
        clearStroke();
        paint();
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPainting]);

  // True while the brush should be live: the brush tool, or the colour-range
  // tool with its in-panel brush mode selected.
  const brushActive = mode === "edit" && (tool === "brush" || (tool === "colorrange" && crMode === "brush"));

  // Leaving brush mode / edit discards any in-progress stroke.
  useEffect(() => {
    if (!brushActive) {
      clearStroke();
      brushHoverRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushActive]);

  // -------- Mouse events --------
  const SNAP_RADIUS_SCREEN = 8;

  const onMouseMove = (e: React.MouseEvent) => {
    if (brushActive) {
      // While painting, the window listener does the stamping; here we only
      // keep the size ring under the cursor.
      if (!paintingRef.current) {
        brushHoverRef.current = imgPixelClamped(e.clientX, e.clientY);
        if (hoverCid) setHoverCid(0);
        paint();
      }
      return;
    }
    if (mode === "edit" && tool === "colorrange") {
      if (hoverCid) setHoverCid(0);
      return;
    }
    if (mode === "edit" && tool === "lasso") {
      // Float, unclamped coords so we can snap onto the image frame and with
      // sub-pixel accuracy. The snap query uses the raw float position; the
      // cursor used for the live-wire tail is the nearest *corner* (round, not
      // floor — the whole lasso path lives on the pixel-corner grid). It also
      // must be an integer (it indexes the parent typed-array).
      const fp = screenToImageF(e.clientX, e.clientY);
      const eg = edgeGraphRef.current;
      const fit = fitRef.current;
      cursorRef.current = fp && mask
        ? { x: Math.max(0, Math.min(mask.width, Math.round(fp.x))),
            y: Math.max(0, Math.min(mask.height, Math.round(fp.y))) }
        : null;
      if (eg && fp && fit) {
        const radiusImg = SNAP_RADIUS_SCREEN / fit.scale;
        currentSnapRef.current = findNearestEdge(eg, fp.x, fp.y, radiusImg);
      } else {
        currentSnapRef.current = null;
      }
      paint();
      // Refresh the corridor preview toward the new cursor (coalesced).
      if (seedsRef.current.length > 0) void recomputePreview();
      if (hoverCid) setHoverCid(0);
      return;
    }
    if (mode === "edit" && tool === "wand") {
      const p = screenToImage(e.clientX, e.clientY);
      const prev = wandHoverRef.current;
      wandHoverRef.current = p;
      if (hoverCid) setHoverCid(0);
      if (!p) return;
      // Re-flood only when the hovered pixel actually changes.
      if (!prev || prev.x !== p.x || prev.y !== p.y) void recomputeWand();
      return;
    }
    const p = screenToImage(e.clientX, e.clientY);
    currentSnapRef.current = null;
    // Hover highlight works in both preview and edit.
    if (!p) { if (hoverCid) setHoverCid(0); return; }
    const cid = cidAt(p.x, p.y);
    if (cid !== hoverCid) setHoverCid(cid);
  };

  const onMouseLeave = () => {
    if (hoverCid) setHoverCid(0);
    cursorRef.current = null;
    if (tool === "wand") { wandHoverRef.current = null; wandCostRef.current = null; wandOverlayRef.current = null; wandSelRef.current = null; }
    // Hide the brush ring when the cursor leaves (unless mid-stroke).
    if (brushActive && !paintingRef.current) brushHoverRef.current = null;
    if (tool === "lasso" || tool === "wand" || tool === "colorrange" || brushActive) paint();
  };

  // ---------------- Pan (right or middle mouse button) ----------------
  const onMouseDown = (e: React.MouseEvent) => {
    // Left button with the brush (tool or colour-range brush mode) starts a stroke.
    if (e.button === 0 && brushActive && mask) {
      e.preventDefault();
      // Colour-range brush is clipped to the current selection; plain brush is free.
      strokeClipRef.current = tool === "colorrange" ? (crSelRef.current?.sel ?? null) : null;
      clearStroke();
      paintingRef.current = true;
      setIsPainting(true);
      const p = imgPixelClamped(e.clientX, e.clientY);
      brushHoverRef.current = p;
      if (p) paintTo(p);
      return;
    }
    if (e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    panRef.current = {
      startX: e.clientX, startY: e.clientY,
      basePanX: viewRef.current.panX, basePanY: viewRef.current.panY,
      moved: false,
    };
    setIsPanning(true);
  };
  useEffect(() => {
    if (!isPanning) return;
    const move = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (!p.moved && Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
      viewRef.current.panX = p.basePanX + dx;
      viewRef.current.panY = p.basePanY + dy;
      paint();
    };
    const up = () => {
      panRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [isPanning, paint]);
  const onContextMenu = (e: React.MouseEvent) => {
    // Always suppress the native menu inside the canvas — we use RMB for pan.
    e.preventDefault();
  };

  // ---------------- Zoom (wheel, anchored under cursor) ----------------
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel with the wand active adjusts the selection threshold.
      if (e.shiftKey && toolRef.current === "wand") {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.max(0, Math.min(100, wandThreshRef.current + dir));
        wandThreshRef.current = next;   // update now so fast ticks accumulate
        onWandThresholdRef.current(next);
        return;
      }
      // Shift+wheel with the brush (tool or colour-range brush mode) resizes it
      // (proportional, so big brushes scale fast and small ones stay fine).
      if (e.shiftKey && (toolRef.current === "brush"
          || (toolRef.current === "colorrange" && crModeRef.current === "brush"))) {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const cur = brushSizeRef.current;
        const stepPx = Math.max(1, Math.round(cur * 0.15));
        const next = Math.max(1, Math.min(200, cur + dir * stepPx));
        brushSizeRef.current = next;    // update now so fast ticks accumulate
        onBrushSizeRef.current(next);
        return;
      }
      // Shift+wheel with the lasso tunes the snap-contrast floor: higher means
      // only sharper boundaries attract the path. Refresh the tail immediately.
      if (e.shiftKey && toolRef.current === "lasso") {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.max(0, Math.min(100, lassoThreshRef.current + dir));
        lassoThreshRef.current = next;  // update now so the recompute uses it
        onLassoThresholdRef.current(next);
        recomputePreviewRef.current();
        return;
      }
      const fit = fitRef.current;
      if (!fit) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Pre-zoom image coords under the cursor.
      const imgX = (sx - fit.dx) / fit.scale;
      const imgY = (sy - fit.dy) / fit.scale;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.max(0.1, Math.min(50, viewRef.current.zoom * factor));
      viewRef.current.zoom = newZoom;
      // Solve pan so the same image-point stays under the cursor.
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const fitScale = Math.min(w / fit.iw, h / fit.ih);
      const newScale = fitScale * newZoom;
      const newDx = sx - imgX * newScale;
      const newDy = sy - imgY * newScale;
      const baseDx = (w - fit.iw * newScale) / 2;
      const baseDy = (h - fit.ih * newScale) / 2;
      viewRef.current.panX = newDx - baseDx;
      viewRef.current.panY = newDy - baseDy;
      paint();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [paint]);

  // Lasso routing tuning (see liveWire.worker.ts):
  //  CORRIDOR  — how hard the path is pulled toward the straight seed→cursor
  //              line. Higher = straighter / less magnetic; lower = grabbier.
  //  THRESHOLD — contrast below this (0..1) is treated as flat background, so
  //              faint noise no longer attracts the path.
  //  MARGIN    — how far (px) the search window extends beyond the seed/cursor
  //              box, i.e. the most the path may bow out to grab nearby edges.
  const LASSO_CORRIDOR = 0.02;
  const LASSO_MARGIN = 64;
  // Snap-contrast floor is user-tunable (Shift+wheel); read it live so changes
  // mid-trace take effect on the next path computation. 0..100 → 0..1.
  const lassoOpts = () => ({ corridor: LASSO_CORRIDOR, threshold: lassoThreshRef.current / 100 });

  const lassoWindow = (sx: number, sy: number, tx: number, ty: number) => ({
    x0: Math.min(sx, tx) - LASSO_MARGIN, y0: Math.min(sy, ty) - LASSO_MARGIN,
    x1: Math.max(sx, tx) + LASSO_MARGIN, y1: Math.max(sy, ty) + LASSO_MARGIN,
  });

  // Recompute the preview parent from the last seed toward the current cursor.
  // The corridor cost is anchored on this seed→cursor line, so the result must
  // be refreshed as the cursor moves — coalesced to one in-flight request.
  const recomputePreview = useCallback(async () => {
    const engine = lassoEngineRef.current;
    if (!engine || !engine.hasEdgeMap() || !mask) return;
    const seed = seedsRef.current[seedsRef.current.length - 1];
    if (!seed) return;
    if (parentBusyRef.current) { parentDirtyRef.current = true; return; }
    parentBusyRef.current = true;
    parentDirtyRef.current = false;
    // Anchor the corridor on the snap target if snapping, else the cursor.
    const snap = currentSnapRef.current;
    const cur = snap
      ? { x: snap.cornerX, y: snap.cornerY }
      : (cursorRef.current ?? { x: seed.x, y: seed.y });
    const tx = Math.max(0, Math.min(mask.width, cur.x));
    const ty = Math.max(0, Math.min(mask.height, cur.y));
    const seq = latestParentSeqRef.current + 1;
    latestParentSeqRef.current = seq;
    try {
      const { parent } = await engine.computeFrom(
        seed.x, seed.y, tx, ty, lassoOpts(), lassoWindow(seed.x, seed.y, tx, ty),
      );
      if (seq === latestParentSeqRef.current) { currentParentRef.current = parent; paint(); }
    } finally {
      parentBusyRef.current = false;
      if (parentDirtyRef.current) void recomputePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, paint]);
  recomputePreviewRef.current = recomputePreview;

  // Magic-wand flood from the pixel currently under the cursor. Coalesced: one
  // worker request in flight; if the cursor moved again, re-run on return. The
  // whole image is flooded so the selection is never clipped.
  const recomputeWand = useCallback(async () => {
    const engine = lassoEngineRef.current;
    if (!engine || !engine.hasEdgeMap() || !mask) return;
    const p = wandHoverRef.current;
    if (!p) return;
    if (wandBusyRef.current) { wandDirtyRef.current = true; return; }
    wandBusyRef.current = true;
    wandDirtyRef.current = false;
    const sx = Math.max(0, Math.min(mask.width - 1, p.x));
    const sy = Math.max(0, Math.min(mask.height - 1, p.y));
    const seq = wandSeqRef.current + 1;
    wandSeqRef.current = seq;
    try {
      const res = await engine.computeWand(sx, sy, { x0: 0, y0: 0, x1: mask.width - 1, y1: mask.height - 1 });
      if (res && seq === wandSeqRef.current) {
        wandCostRef.current = { ...res, seedX: sx, seedY: sy, phaseIdx: mask.labels[sy * mask.width + sx] };
        wandOverlayRef.current = null; // new cost map → rebuild overlay
        wandSelRef.current = null;
        paint();
      }
    } finally {
      wandBusyRef.current = false;
      if (wandDirtyRef.current) void recomputeWand();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, paint]);

  /** Image-pixel distance to the first seed (or +Inf if no seeds). */
  const distToFirstSeedPx = (p: Pt): number => {
    const s0 = seedsRef.current[0];
    if (!s0) return Infinity;
    const dx = p.x - s0.x, dy = p.y - s0.y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const CLOSE_RADIUS_SCREEN = 10; // px on screen, scaled to image px on use
  const closeRadiusImage = () => {
    const fit = fitRef.current;
    return fit ? CLOSE_RADIUS_SCREEN / fit.scale : 6;
  };

  const closeLasso = useCallback(() => {
    if (!mask || cutPhaseIdxRef.current === null) return;
    const base = committedPathRef.current.slice();
    // Too little to enclose anything — keep the lasso, never wipe it silently.
    if (base.length < 2) return;
    const first = seedsRef.current[0];
    const cutClass = cutPhaseIdxRef.current;

    // Optional border-following closing segment (last seed → first seed) so the
    // close hugs a shared border instead of cutting straight across.
    const prev = seedsRef.current[seedsRef.current.length - 1];
    const eg = edgeGraphRef.current;
    let closeSeg: Pt[] | null = null;
    if (eg && prev.cornerIdx !== null && first.cornerIdx !== null) {
      const path = pathAlongEdge(eg, prev.cornerIdx, first.cornerIdx);
      if (path && path.xs.length > 0) {
        closeSeg = [];
        for (let i = 0; i < path.xs.length; i++) closeSeg.push({ x: path.xs[i], y: path.ys[i] });
      }
    }
    if (!closeSeg) {
      const parent = currentParentRef.current;
      if (parent) {
        const path = pathFromParent(parent, mask.width + 1, first.x, first.y);
        if (path) {
          closeSeg = [];
          for (let i = path.xs.length - 1; i >= 0; i--) closeSeg.push({ x: path.xs[i], y: path.ys[i] });
        }
      }
    }
    const withSeg = base.slice();
    if (closeSeg && closeSeg.length > 0) {
      const lastPt = withSeg[withSeg.length - 1];
      if (lastPt.x === closeSeg[0].x && lastPt.y === closeSeg[0].y) closeSeg.shift();
      for (const p of closeSeg) withSeg.push(p);
    }

    // Rasterize `poly` (+ straight line back to first) and return the covered
    // pixels, or null if it encloses nothing. Points are pixel-corner coords →
    // polygon edges run along grid lines, so pixel membership is unambiguous.
    const rasterize = (poly: Pt[]) => {
      const c = document.createElement("canvas");
      c.width = mask.width; c.height = mask.height;
      const rctx = c.getContext("2d", { willReadFrequently: true })!;
      rctx.fillStyle = "#fff";
      rctx.beginPath();
      rctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) rctx.lineTo(poly[i].x, poly[i].y);
      rctx.lineTo(first.x, first.y);
      rctx.closePath();
      rctx.fill();
      const px = rctx.getImageData(0, 0, mask.width, mask.height).data;
      const cutMask = new Uint8Array(mask.width * mask.height);
      let count = 0, x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
      for (let i = 0; i < cutMask.length; i++) {
        if (px[i * 4 + 3] >= 128) {
          cutMask[i] = 1; count++;
          const y = (i / mask.width) | 0, x = i - y * mask.width;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return count === 0 ? null : { cutMask, x0, y0, x1, y1 };
    };

    // Prefer the border-following close; if it collapses to nothing (degenerate
    // winding — e.g. the close path retraced the trace), fall back to a straight
    // close. Only give up if BOTH enclose nothing, and even then keep the lasso
    // instead of silently discarding the user's trace.
    const res = rasterize(withSeg) ?? rasterize(base);
    if (!res) return;

    const cx = (res.x0 + res.x1) / 2, cy = (res.y0 + res.y1) / 2;
    const screen = imageToScreen(cx, cy) ?? { x: 0, y: 0 };
    onLassoCut({
      cutMask: res.cutMask,
      bbox: { x0: res.x0, y0: res.y0, x1: res.x1, y1: res.y1 },
      phaseIdx: cutClass,
      x: screen.x, y: screen.y,
    });
    cancelLasso();
  }, [mask, onLassoCut, cancelLasso]);

  const onClick = async (e: React.MouseEvent) => {
    if (mode !== "edit") return;
    if (tool === "brush") return;   // brush paints via mouse down / drag / up
    const p = screenToImage(e.clientX, e.clientY);
    if (tool === "colorrange") {
      if (crModeRef.current === "brush") return;   // brush mode paints via drag
      const data = origRgbRef.current;
      if (!p || !data) return;
      const o = (p.y * data.w + p.x) * 3;
      const col: RGB = [data.rgb[o], data.rgb[o + 1], data.rgb[o + 2]];
      const dup = (a: RGB[]) => a.some((c) => c[0] === col[0] && c[1] === col[1] && c[2] === col[2]);
      if (crModeRef.current === "plus") setCrInclude((a) => (dup(a) ? a : [...a, col]));
      else setCrExclude((a) => (dup(a) ? a : [...a, col]));
      return;
    }
    if (tool === "cursor") {
      if (!mask || !p) { onRegionClick(null); return; }
      const cid = cidAt(p.x, p.y);
      if (!cid) { onRegionClick(null); return; }
      const phaseIdx = mask.labels[p.y * mask.width + p.x];
      onRegionClick({ cid, phaseIdx, x: e.clientX, y: e.clientY });
      return;
    }
    if (tool === "wand") {
      const wc = wandCostRef.current;
      const selRes = wandSelection();
      if (!mask || !wc || !selRes) return;
      const { sel, winW, x0: sx0, y0: sy0 } = selRes;
      const cutMask = new Uint8Array(mask.width * mask.height);
      let count = 0, x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
      for (let i = 0; i < sel.length; i++) {
        if (sel[i]) {
          const wy = (i / winW) | 0, wx = i - wy * winW;
          const ix = sx0 + wx, iy = sy0 + wy;
          cutMask[iy * mask.width + ix] = 1;
          count++;
          if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
          if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
        }
      }
      if (count === 0) return;
      const screen = imageToScreen((x0 + x1) / 2, (y0 + y1) / 2) ?? { x: e.clientX, y: e.clientY };
      onLassoCut({ cutMask, bbox: { x0, y0, x1, y1 }, phaseIdx: wc.phaseIdx, x: screen.x, y: screen.y });
      return;
    }
    // tool === "lasso" — use float, unclamped coords so the image frame
    // (corner coords up to w / h) is reachable.
    if (!mask) return;
    const fp = screenToImageF(e.clientX, e.clientY);
    if (!fp) return;

    const snap = currentSnapRef.current;
    // Pixel under the cursor (for the cut class), and the nearest pixel-corner
    // (for unsnapped seeds — the whole path lives on the corner grid).
    const pxI = Math.max(0, Math.min(mask.width - 1, Math.floor(fp.x)));
    const pyI = Math.max(0, Math.min(mask.height - 1, Math.floor(fp.y)));
    const cornerX = Math.max(0, Math.min(mask.width, Math.round(fp.x)));
    const cornerY = Math.max(0, Math.min(mask.height, Math.round(fp.y)));
    // Ignore clicks well outside the image that aren't snapping to anything.
    const nearImage =
      fp.x >= -2 && fp.y >= -2 &&
      fp.x <= mask.width + 2 && fp.y <= mask.height + 2;
    if (!snap && !nearImage) return;

    // Effective seed coords: snap takes priority (it can sit on the frame).
    const sx = snap ? snap.cornerX : cornerX;
    const sy = snap ? snap.cornerY : cornerY;
    const seedPt: SeedPt = {
      x: sx, y: sy,
      cornerIdx: snap?.cornerIdx ?? null,
    };

    // First seed determines the phase we're cutting from.
    if (seedsRef.current.length === 0) {
      // Use the pixel under the cursor so the cut class is the one being
      // *pointed at*, not whichever side of the edge we snapped to.
      cutPhaseIdxRef.current = mask.labels[pyI * mask.width + pxI];
      setSeeds([seedPt]);
      committedPathRef.current = [{ x: sx, y: sy }];
      void recomputePreview();
      paint();
      return;
    }
    // Close on first seed.
    if (seedsRef.current.length >= 2 && distToFirstSeedPx({ x: sx, y: sy }) <= closeRadiusImage()) {
      closeLasso();
      return;
    }

    // Decide path strategy: BFS over the entire edge grid when BOTH ends
    // are snapped; otherwise live-wire.
    const prev = seedsRef.current[seedsRef.current.length - 1];
    const eg = edgeGraphRef.current;
    let segment: Pt[] | null = null;
    if (eg && snap && prev.cornerIdx !== null) {
      const path = pathAlongEdge(eg, prev.cornerIdx, snap.cornerIdx);
      if (path && path.xs.length > 0) {
        segment = [];
        for (let i = 0; i < path.xs.length; i++) {
          segment.push({ x: path.xs[i], y: path.ys[i] });
        }
      }
    }
    if (!segment) {
      // Live-wire on the corner grid. Compute a fresh corridor path from the
      // previous seed straight to the clicked corner, so the committed segment
      // is exactly the one anchored on this seed→click line.
      const engine = lassoEngineRef.current;
      if (!engine || !engine.hasEdgeMap()) return;
      latestParentSeqRef.current += 1;   // supersede any in-flight preview
      const { parent } = await engine.computeFrom(
        prev.x, prev.y, sx, sy, lassoOpts(), lassoWindow(prev.x, prev.y, sx, sy),
      );
      const path = pathFromParent(parent, mask.width + 1, sx, sy);
      if (!path) return;
      segment = [];
      for (let i = path.xs.length - 1; i >= 0; i--) {
        segment.push({ x: path.xs[i], y: path.ys[i] });
      }
    }

    const committed = committedPathRef.current;
    if (committed.length > 0 && segment.length > 0) {
      const last = committed[committed.length - 1];
      if (last.x === segment[0].x && last.y === segment[0].y) segment.shift();
    }
    committedPathRef.current = committed.concat(segment);
    setSeeds((s) => [...s, seedPt]);
    void recomputePreview();
    paint();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (mode === "edit" && tool === "lasso") {
      e.preventDefault();
      closeLasso();
    }
  };

  // Keyboard: Enter close, Esc cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "edit" || tool !== "lasso") return;
      if (e.key === "Escape") { e.preventDefault(); cancelLasso(); }
      else if (e.key === "Enter") { e.preventDefault(); closeLasso(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, tool, closeLasso, cancelLasso]);

  // -------- Colour-range panel actions --------
  const handleRemoveSample = (kind: "include" | "exclude", i: number) => {
    if (kind === "include") setCrInclude((a) => a.filter((_, k) => k !== i));
    else setCrExclude((a) => a.filter((_, k) => k !== i));
  };
  const handleCrReset = () => { setCrInclude([]); setCrExclude([]); };
  const handleCrFillAll = () => {
    const cr = crSelRef.current, m = maskRef.current;
    if (!cr || !m) return;
    let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1, count = 0;
    for (let i = 0; i < cr.sel.length; i++) {
      if (cr.sel[i]) {
        count++;
        const y = (i / m.width) | 0, x = i - y * m.width;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (count === 0) return;
    onLassoCut({ cutMask: cr.sel, bbox: { x0, y0, x1, y1 }, phaseIdx: targetPhaseIdx, x: 0, y: 0 });
    setCrInclude([]); setCrExclude([]);   // fill resets the selection
  };

  return (
    <div
      className={
        "canvas-wrap"
        + (tool === "lasso" && mode === "edit" ? " tool-lasso" : "")
        + (tool === "brush" && mode === "edit" ? " tool-brush" : "")
        + (tool === "colorrange" && mode === "edit" ? " tool-colorrange" : "")
        + (isPanning ? " panning" : "")
      }
      ref={wrapRef}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} />
      <PerfHud />
      {!id && <div className="placeholder">Select a mask from the sidebar</div>}
      {error && <div className="placeholder" style={{ color: "#f88" }}>{error}</div>}
      {orig && mask && (
        <div className="canvas-hud">
          <span>{id}</span>
          <span>·</span>
          <span>
            {mask.width}×{mask.height}
            {(orig.naturalWidth !== mask.width || orig.naturalHeight !== mask.height) &&
              ` (orig ${orig.naturalWidth}×${orig.naturalHeight})`}
          </span>
          <span>·</span>
          <span>mask: {maskSource}</span>
          <span>·</span>
          <span>phases: {mask.phases.length}</span>
          {components && (<><span>·</span><span>regions: {components.count}</span></>)}
          <span>·</span>
          <span>
            mode: {
              spaceHeld
                ? (mode === "preview" ? "orig (space)" : "mask (space)")
                : mode
            }
          </span>
          {mode === "edit" && (<><span>·</span><span>tool: {tool}</span></>)}
        </div>
      )}
      {mode === "edit" && tool === "colorrange" && (
        <ColorRangePanel
          origRgb={origRgb}
          include={crInclude}
          exclude={crExclude}
          tolerance={crTolerance}
          onTolerance={setCrTolerance}
          minArea={crMinArea}
          onMinArea={setCrMinArea}
          fillArea={crFillArea}
          onFillArea={setCrFillArea}
          smooth={crSmooth}
          onSmooth={setCrSmooth}
          mode={crMode}
          onMode={setCrMode}
          brushSize={brushSize}
          onBrushSize={onBrushSize}
          onRemoveSample={handleRemoveSample}
          selectedCount={crCount}
          phases={phases}
          targetPhaseIdx={targetPhaseIdx}
          onTargetPhase={onTargetPhase}
          onReset={handleCrReset}
          onFillAll={handleCrFillAll}
        />
      )}
    </div>
  );
}
