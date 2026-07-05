import { useEffect, useRef } from "react";
import { type Phase, type RGB, rgbToHex } from "./mask";
import { TargetPhaseBox } from "./TargetPhaseBox";

type Props = {
  origRgb: { rgb: Uint8Array; w: number; h: number } | null;
  include: RGB[];
  exclude: RGB[];
  tolerance: number;                       // 0..100
  onTolerance: (v: number) => void;
  minArea: number;                         // remove islands ≤ N px (0 = off)
  onMinArea: (v: number) => void;
  fillArea: number;                        // fill holes ≤ N px (0 = off)
  onFillArea: (v: number) => void;
  smooth: number;                          // edge smoothing radius (0 = off)
  onSmooth: (v: number) => void;
  mode: "plus" | "minus" | "brush";        // active sub-tool
  onMode: (m: "plus" | "minus" | "brush") => void;
  brushSize: number;
  onBrushSize: (v: number) => void;
  onRemoveSample: (kind: "include" | "exclude", i: number) => void;
  selectedCount: number;
  phases: Phase[];
  targetPhaseIdx: number;
  onTargetPhase: (i: number) => void;
  onReset: () => void;
  onFillAll: () => void;
};

const SCAT = 188;   // scatter canvas size (css px)

/** RGB → 2D chroma-plane position (vectorscope-like): grays cluster in the
 *  centre, saturated colours spread out, hue runs around. Returns 0..1 coords. */
function chromaXY(r: number, g: number, b: number): [number, number] {
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const cb = (b / 255) - luma;   // ≈ -0.886..0.886
  const cr = (r / 255) - luma;   // ≈ -0.701..0.701
  const x = 0.5 + cb * 0.72;
  const y = 0.5 - cr * 0.85;
  return [x < 0 ? 0 : x > 1 ? 1 : x, y < 0 ? 0 : y > 1 ? 1 : y];
}

export function ColorRangePanel({
  origRgb, include, exclude, tolerance, onTolerance,
  minArea, onMinArea, fillArea, onFillArea, smooth, onSmooth,
  mode, onMode, brushSize, onBrushSize, onRemoveSample, selectedCount, phases,
  targetPhaseIdx, onTargetPhase, onReset, onFillAll,
}: Props) {
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);

  // Vectorscope scatter of the image's colours + the picked samples on it.
  useEffect(() => {
    const cv = scatterRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = SCAT * dpr; cv.height = SCAT * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SCAT, SCAT);
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, SCAT, SCAT);
    // faint hue ring border
    const ring = ctx.createConicGradient ? ctx.createConicGradient(0, SCAT / 2, SCAT / 2) : null;
    if (ring) {
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        ring.addColorStop(t, `hsl(${Math.round(t * 360)}, 80%, 55%)`);
      }
      ctx.strokeStyle = ring as unknown as string;
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, SCAT - 3, SCAT - 3);
    }
    if (origRgb) {
      const { rgb, w, h } = origRgb;
      const n = w * h;
      const stride = Math.max(1, Math.floor(n / 12000));
      for (let i = 0; i < n; i += stride) {
        const o = i * 3, r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
        const [x, y] = chromaXY(r, g, b);
        ctx.fillStyle = `rgba(${r},${g},${b},0.5)`;
        ctx.fillRect(x * SCAT, y * SCAT, 2, 2);
      }
    }
    const tolR = (tolerance / 100) * SCAT * 0.5;
    const mark = (cols: RGB[], stroke: string) => {
      for (const c of cols) {
        const [x, y] = chromaXY(c[0], c[1], c[2]);
        const px = x * SCAT, py = y * SCAT;
        if (tolR > 1) {
          ctx.beginPath();
          ctx.arc(px, py, tolR, 0, Math.PI * 2);
          ctx.fillStyle = stroke === "#fff" ? "rgba(168,85,247,0.18)" : "rgba(255,80,80,0.14)";
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = rgbToHex(c);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    };
    mark(include, "#fff");
    mark(exclude, "#ff5050");
  }, [origRgb, include, exclude, tolerance]);

  // 1D gradient strip of the include colours (sorted by brightness) — the band.
  useEffect(() => {
    const cv = stripRef.current;
    if (!cv) return;
    const W = cv.clientWidth || 220, H = 16;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (include.length === 0) {
      ctx.fillStyle = "#171a21";
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const sorted = [...include].sort(
      (a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]),
    );
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    sorted.forEach((c, i) => {
      const t = sorted.length === 1 ? 0 : i / (sorted.length - 1);
      grad.addColorStop(t, rgbToHex(c));
      if (sorted.length === 1) grad.addColorStop(1, rgbToHex(c));
    });
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }, [include]);

  const total = origRgb ? origRgb.w * origRgb.h : 0;
  const pct = total > 0 ? ((selectedCount / total) * 100).toFixed(1) : "0";
  const hasSel = selectedCount > 0;

  return (
    <div
      className="cr-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="cr-title">Цветовой диапазон</div>

      <div className="cr-eyedroppers">
        <button
          className={"cr-pick" + (mode === "plus" ? " active" : "")}
          onClick={() => onMode("plus")}
          title="Пипетка + : клик по холсту добавляет цвет в диапазон"
        >
          <span className="dot" /> +
        </button>
        <button
          className={"cr-pick minus" + (mode === "minus" ? " active" : "")}
          onClick={() => onMode("minus")}
          title="Пипетка − : клик по холсту исключает цвет из диапазона"
        >
          <span className="dot" /> −
        </button>
        <button
          className={"cr-pick brush" + (mode === "brush" ? " active" : "")}
          onClick={() => onMode(mode === "brush" ? "plus" : "brush")}
          title="Кисть: рисовать целевым цветом внутри выделения (Shift+колесо — размер)"
        >
          ✎ Кисть
        </button>
      </div>

      <label className="cr-row">
        <span className="cr-lbl">Допуск</span>
        <input
          type="range" min={0} max={100} step={1}
          value={tolerance}
          onChange={(e) => onTolerance(Math.max(0, Math.min(100, Math.round(+e.target.value))))}
        />
        <span className="cr-val">{tolerance}</span>
      </label>

      <label className="cr-row" title="Убирать выделенные островки площадью до N пикселей (0 — не убирать)">
        <span className="cr-lbl">Отсечь</span>
        <input
          type="range" min={0} max={50} step={1}
          value={minArea}
          onChange={(e) => onMinArea(Math.max(0, Math.min(50, Math.round(+e.target.value))))}
        />
        <span className="cr-val">{minArea}</span>
      </label>

      <label className="cr-row" title="Заполнять дырки в выделении площадью до N пикселей (0 — не заполнять)">
        <span className="cr-lbl">Заливка</span>
        <input
          type="range" min={0} max={50} step={1}
          value={fillArea}
          onChange={(e) => onFillArea(Math.max(0, Math.min(50, Math.round(+e.target.value))))}
        />
        <span className="cr-val">{fillArea}</span>
      </label>

      <label className="cr-row" title="Сглаживание контура выделения — радиус (0 — без сглаживания)">
        <span className="cr-lbl">Сглаж.</span>
        <input
          type="range" min={0} max={10} step={1}
          value={smooth}
          onChange={(e) => onSmooth(Math.max(0, Math.min(10, Math.round(+e.target.value))))}
        />
        <span className="cr-val">{smooth}</span>
      </label>

      {mode === "brush" && (
        <label className="cr-row" title="Размер кисти (Shift+колесо над холстом)">
          <span className="cr-lbl">Размер</span>
          <input
            type="range" min={1} max={200} step={1}
            value={brushSize}
            onChange={(e) => onBrushSize(Math.max(1, Math.min(200, Math.round(+e.target.value))))}
          />
          <span className="cr-val">{brushSize}</span>
        </label>
      )}

      <div className="cr-preview">
        <canvas ref={scatterRef} style={{ width: SCAT, height: SCAT }} />
        <canvas ref={stripRef} className="cr-strip" />
      </div>

      {(include.length > 0 || exclude.length > 0) && (
        <div className="cr-samples">
          {include.map((c, i) => (
            <button
              key={"i" + i} className="cr-swatch inc"
              style={{ background: rgbToHex(c) }}
              title={`${rgbToHex(c)} — клик чтобы убрать`}
              onClick={() => onRemoveSample("include", i)}
            />
          ))}
          {exclude.map((c, i) => (
            <button
              key={"e" + i} className="cr-swatch exc"
              style={{ background: rgbToHex(c) }}
              title={`исключён ${rgbToHex(c)} — клик чтобы убрать`}
              onClick={() => onRemoveSample("exclude", i)}
            />
          ))}
        </div>
      )}

      <div className="cr-count">
        Выделено: {selectedCount.toLocaleString("ru")} px ({pct}%)
      </div>

      {hasSel && (
        <button className="cr-reset" onClick={onReset}>Сбросить выделение</button>
      )}

      <div className="cr-sep" />

      <div className="cr-target">
        <span className="cr-lbl">Целевой цвет</span>
        {phases.length > 0
          ? <TargetPhaseBox phases={phases} value={targetPhaseIdx} onChange={onTargetPhase} />
          : <span className="cr-muted">нет маски</span>}
      </div>

      <div className="cr-actions">
        <button className="cr-fill" disabled={!hasSel} onClick={onFillAll}>
          Заполнить все
        </button>
      </div>
    </div>
  );
}
