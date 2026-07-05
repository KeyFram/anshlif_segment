import { useCallback, useEffect, useRef, useState } from "react";
import { PALETTE, PREVIEW_COLORS, type PreviewParams } from "../../shared/types";

type Props = {
  origSrc: string;
  maskSrc: string;
  params: PreviewParams;
  onParamsChange: (p: PreviewParams) => void;
};

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => res(im); im.onerror = () => rej(new Error(url)); im.src = url;
  });
}

// Nearest palette index for an RGB (silicate/magnetite → bg, talc → talc, sulfides → sulfide).
const PAL = PALETTE.map((p) => p.color);
function nearestPal(r: number, g: number, b: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < PAL.length; i++) {
    const c = PAL[i], d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

type Pre = {
  w: number; h: number;
  orig: HTMLCanvasElement;      // original drawn at mask resolution
  classMap: Uint8Array;         // 0 bg (силикат/магнетит), 1 тальк, 2 сульфид
  compId: Int32Array;           // sulfide component id (0 = not sulfide)
  area: Float64Array;           // per component id
  perim: Float64Array;
  ncomp: number;
};

/** 4-connected sulfide components with area + perimeter (edge/other-class border). */
function sulfideComps(cls: Uint8Array, w: number, h: number) {
  const compId = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const areaL: number[] = [0], perimL: number[] = [0];  // 1-indexed
  let ncomp = 0;
  for (let s = 0; s < w * h; s++) {
    if (cls[s] !== 2 || compId[s]) continue;
    const id = ++ncomp; let head = 0, tail = 0, area = 0, perim = 0;
    queue[tail++] = s; compId[s] = id;
    while (head < tail) {
      const p = queue[head++]; area++;
      const y = (p / w) | 0, x = p - y * w;
      let border = false;
      // 4 neighbours
      if (x > 0) { const q = p - 1; if (cls[q] === 2) { if (!compId[q]) { compId[q] = id; queue[tail++] = q; } } else border = true; } else border = true;
      if (x < w - 1) { const q = p + 1; if (cls[q] === 2) { if (!compId[q]) { compId[q] = id; queue[tail++] = q; } } else border = true; } else border = true;
      if (y > 0) { const q = p - w; if (cls[q] === 2) { if (!compId[q]) { compId[q] = id; queue[tail++] = q; } } else border = true; } else border = true;
      if (y < h - 1) { const q = p + w; if (cls[q] === 2) { if (!compId[q]) { compId[q] = id; queue[tail++] = q; } } else border = true; } else border = true;
      if (border) perim++;
    }
    areaL[id] = area; perimL[id] = perim;
  }
  return { compId, area: Float64Array.from(areaL), perim: Float64Array.from(perimL), ncomp };
}

/** Competition preview: post-processed colour mask over the original. Sulfide
 *  ("срастания") components split thin (red) / normal (green) by area + thickness;
 *  тальк blue, силикат/магнетит black. Params tuned live in the strip on top. */
export function PreviewMask({ origSrc, maskSrc, params, onParamsChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preRef = useRef<Pre | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [peek, setPeek] = useState(false);
  const view = useRef({ zoom: 1, panX: 0, panY: 0 });
  const paramsRef = useRef(params); paramsRef.current = params;

  const applyTransform = useCallback(() => {
    const wrap = wrapRef.current, cv = canvasRef.current, pre = preRef.current;
    if (!wrap || !cv || !pre) return;
    const fit = Math.min(wrap.clientWidth / pre.w, wrap.clientHeight / pre.h);
    const s = fit * view.current.zoom;
    const x = (wrap.clientWidth - pre.w * s) / 2 + view.current.panX;
    const y = (wrap.clientHeight - pre.h * s) / 2 + view.current.panY;
    cv.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }, []);

  const draw = useCallback(() => {
    const pre = preRef.current, cv = canvasRef.current;
    if (!pre || !cv) return;
    if (cv.width !== pre.w) { cv.width = pre.w; cv.height = pre.h; }
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, pre.w, pre.h);
    ctx.drawImage(pre.orig, 0, 0);
    if (!peek) {
      const P = paramsRef.current;
      const compClass = new Uint8Array(pre.ncomp + 1);   // 0 normal, 1 thin
      for (let id = 1; id <= pre.ncomp; id++) {
        const a = pre.area[id], p = pre.perim[id] || 1;
        compClass[id] = (a < P.minArea || a / p < P.minThickness) ? 1 : 0;
      }
      const C = PREVIEW_COLORS;
      const buf = new Uint8ClampedArray(pre.w * pre.h * 4);
      for (let i = 0; i < pre.w * pre.h; i++) {
        const cm = pre.classMap[i];
        const col = cm === 1 ? C.talc : cm === 2 ? (compClass[pre.compId[i]] ? C.thin : C.normal) : C.bg;
        const o = i * 4; buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = 255;
      }
      const otmp = document.createElement("canvas");
      otmp.width = pre.w; otmp.height = pre.h;
      otmp.getContext("2d")!.putImageData(new ImageData(buf, pre.w, pre.h), 0, 0);
      ctx.globalAlpha = P.opacity;
      ctx.drawImage(otmp, 0, 0);
      ctx.globalAlpha = 1;
    }
    applyTransform();
  }, [peek, applyTransform]);

  // Load + precompute when the item changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(false);
    Promise.all([loadImg(origSrc), loadImg(maskSrc)]).then(([orig, mask]) => {
      if (cancelled) return;
      const w = mask.naturalWidth, h = mask.naturalHeight;
      const oc = document.createElement("canvas"); oc.width = w; oc.height = h;
      oc.getContext("2d")!.drawImage(orig, 0, 0, w, h);
      const mc = document.createElement("canvas"); mc.width = w; mc.height = h;
      const mctx = mc.getContext("2d", { willReadFrequently: true })!;
      mctx.imageSmoothingEnabled = false; mctx.drawImage(mask, 0, 0);
      const mpx = mctx.getImageData(0, 0, w, h).data;
      const classMap = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const idx = nearestPal(mpx[i * 4], mpx[i * 4 + 1], mpx[i * 4 + 2]);
        classMap[i] = idx === 3 ? 1 : idx === 1 ? 2 : 0;   // тальк / сульфид / bg
      }
      const { compId, area, perim, ncomp } = sulfideComps(classMap, w, h);
      preRef.current = { w, h, orig: oc, classMap, compId, area, perim, ncomp };
      view.current = { zoom: 1, panX: 0, panY: 0 };
      setLoading(false);
      draw();
    }).catch(() => { if (!cancelled) { setErr(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [origSrc, maskSrc, draw]);

  // Redraw overlay when params change.
  useEffect(() => { if (!loading) draw(); }, [params, loading, draw]);

  // Space peeks the clean original (hide overlay).
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !typing(e.target)) { e.preventDefault(); setPeek(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setPeek(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Wheel zoom + drag pan.
  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      const pre = preRef.current; if (!pre) return; e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const fit = Math.min(wrap.clientWidth / pre.w, wrap.clientHeight / pre.h);
      const v = view.current, s0 = fit * v.zoom;
      const ox = (wrap.clientWidth - pre.w * s0) / 2 + v.panX;
      const oy = (wrap.clientHeight - pre.h * s0) / 2 + v.panY;
      const ix = (sx - ox) / s0, iy = (sy - oy) / s0;
      v.zoom = Math.max(0.2, Math.min(40, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const s1 = fit * v.zoom;
      v.panX = sx - ix * s1 - (wrap.clientWidth - pre.w * s1) / 2;
      v.panY = sy - iy * s1 - (wrap.clientHeight - pre.h * s1) / 2;
      applyTransform();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [applyTransform]);

  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current; if (!d) return;
      view.current.panX = d.px + (e.clientX - d.x);
      view.current.panY = d.py + (e.clientY - d.y);
      applyTransform();
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [applyTransform]);

  const set = (p: Partial<PreviewParams>) => onParamsChange({ ...params, ...p });

  return (
    <div className="preview-mask">
      <div className="pm-params">
        <div className="pm-legend">
          <span><i style={{ background: `rgb(${PREVIEW_COLORS.normal.join(",")})` }} />обычные</span>
          <span><i style={{ background: `rgb(${PREVIEW_COLORS.thin.join(",")})` }} />тонкие</span>
          <span><i style={{ background: `rgb(${PREVIEW_COLORS.talc.join(",")})` }} />тальк</span>
        </div>
        <label className="pm-ctl" title="Срастания площадью меньше — считаются тонкими">
          Мин. площадь
          <input type="range" min={0} max={5000} step={50} value={params.minArea}
            onChange={(e) => set({ minArea: +e.target.value })} />
          <span className="pm-val">{params.minArea}</span>
        </label>
        <label className="pm-ctl" title="Толщина ≈ площадь/периметр; тоньше — тонкие (ловит ветвистых)">
          Мин. толщина
          <input type="range" min={0} max={20} step={0.5} value={params.minThickness}
            onChange={(e) => set({ minThickness: +e.target.value })} />
          <span className="pm-val">{params.minThickness}</span>
        </label>
        <label className="pm-ctl" title="Прозрачность маски поверх оригинала">
          Прозрачность
          <input type="range" min={0} max={1} step={0.05} value={params.opacity}
            onChange={(e) => set({ opacity: +e.target.value })} />
          <span className="pm-val">{Math.round(params.opacity * 100)}%</span>
        </label>
        <span className="pm-hint">пробел — оригинал</span>
      </div>
      <div className="pm-stage" ref={wrapRef}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, px: view.current.panX, py: view.current.panY }; }}>
        {loading && <div className="pm-msg">Анализ маски…</div>}
        {err && <div className="pm-msg">Не удалось загрузить</div>}
        <canvas ref={canvasRef} className="pm-canvas" />
      </div>
    </div>
  );
}
