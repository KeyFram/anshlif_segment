import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  src: string | null;              // displayed image (normalized/raw photo, or a mask)
  peekSrc?: string | null;         // photo shown while Space is held (peek under mask)
  viewKey?: string;                // selection identity — view resets only when THIS changes
  pending: boolean;                // segmentation running → show the "segmenting" animation
  pixelated?: boolean;             // crisp nearest-neighbour rendering (for flat masks)
  label?: string;                  // small HUD caption (e.g. tile name, size)
  /** When set, show the panorama performance notice instead of an image. */
  panoramaNotice?: boolean;
};

/** Lightweight preview canvas for M1: pan (drag), zoom (wheel, anchored under
 *  the cursor), a "segmentation in progress" shimmer while the mask is pending,
 *  and Space-to-peek the raw original (toggle shows the normalized image). The
 *  full editor (src/editor/CanvasView) takes over here once masks are produced. */
export function ProjectCanvas({ src, peekSrc, viewKey, pending, pixelated, label, panoramaNotice }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [peekImg, setPeekImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [peek, setPeek] = useState(false);
  const view = useRef({ zoom: 1, panX: 0, panY: 0 });
  const [, force] = useState(0);
  const repaint = useCallback(() => force((t) => t + 1), []);

  // Reset the view only when the SELECTION changes — toggling normalize (which
  // swaps `src`) keeps the current pan/zoom so you can A/B the same framing.
  useEffect(() => { view.current = { zoom: 1, panX: 0, panY: 0 }; repaint(); }, [viewKey, repaint]);

  // Load the displayed image whenever its URL changes.
  useEffect(() => {
    setImg(null);
    if (!src) return;
    setLoading(true);
    const image = new Image();
    image.onload = () => { setImg(image); setLoading(false); repaint(); };
    image.onerror = () => setLoading(false);
    image.src = src;
    return () => { image.onload = null; image.onerror = null; };
  }, [src, repaint]);

  // Preload the raw original for Space-peek (same dimensions → shared geometry).
  useEffect(() => {
    setPeekImg(null);
    if (!peekSrc || peekSrc === src) return;
    const image = new Image();
    image.onload = () => setPeekImg(image);
    image.src = peekSrc;
    return () => { image.onload = null; };
  }, [peekSrc, src]);

  // Space peeks the raw original (and hides the shimmer).
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) { e.preventDefault(); setPeek(true); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setPeek(false); };
    const blur = () => setPeek(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Wheel zoom anchored under the cursor.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (!img) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const fit = fitScale(wrap, img);
      const v = view.current;
      const scale = fit * v.zoom;
      const imgX = (sx - originX(wrap, img, v)) / scale;
      const imgY = (sy - originY(wrap, img, v)) / scale;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      v.zoom = Math.max(0.2, Math.min(40, v.zoom * factor));
      const ns = fit * v.zoom;
      const baseX = (wrap.clientWidth - img.naturalWidth * ns) / 2;
      const baseY = (wrap.clientHeight - img.naturalHeight * ns) / 2;
      v.panX = sx - imgX * ns - baseX;
      v.panY = sy - imgY * ns - baseY;
      repaint();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [img, repaint]);

  // Drag to pan.
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onDown = (e: React.MouseEvent) => {
    if (!img) return;
    drag.current = { x: e.clientX, y: e.clientY, px: view.current.panX, py: view.current.panY };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      view.current.panX = d.px + (e.clientX - d.x);
      view.current.panY = d.py + (e.clientY - d.y);
      repaint();
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [repaint]);

  const wrap = wrapRef.current;
  const geom = img ?? peekImg;
  const transform = wrap && geom ? imgTransform(wrap, geom, view.current) : "";
  // While peeking show the raw original (if preloaded); otherwise the display image.
  const shownSrc = peek && peekImg ? peekImg.src : img?.src;

  return (
    <div className="pcanvas" ref={wrapRef} onMouseDown={onDown}>
      {panoramaNotice ? (
        <div className="pcanvas-notice">
          <div className="notice-title">Панорама целиком</div>
          <p>
            Просмотр всей панорамы разом имеет непредсказуемую производительность.
            Рекомендуем открывать составляющие изображения по отдельности —
            разверните панораму в проводнике слева.
          </p>
        </div>
      ) : !src ? (
        <div className="pcanvas-placeholder">Выберите изображение в проводнике</div>
      ) : loading && !geom ? (
        <div className="pcanvas-placeholder">Загрузка…</div>
      ) : geom ? (
        <>
          <div
            className="pcanvas-frame"
            style={{
              width: geom.naturalWidth, height: geom.naturalHeight,
              transform, transformOrigin: "0 0",
            }}
          >
            <img
              className="pcanvas-img"
              src={shownSrc}
              alt=""
              draggable={false}
              style={{ imageRendering: pixelated && !peek ? "pixelated" : "auto" }}
            />
            {pending && !peek && <div className="scan-overlay" />}
          </div>
          {pending && !peek && (
            <div className="scan-badge">
              <span className="scan-dot" /> Идёт сегментация · ждите маску
              <span className="scan-hint">пробел — оригинал</span>
            </div>
          )}
        </>
      ) : (
        <div className="pcanvas-placeholder">Не удалось загрузить изображение</div>
      )}
      {label && <div className="pcanvas-hud">{label}</div>}
    </div>
  );
}

// --- view geometry helpers ---
function fitScale(wrap: HTMLDivElement, img: HTMLImageElement) {
  return Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight);
}
function originX(wrap: HTMLDivElement, img: HTMLImageElement, v: { zoom: number; panX: number }) {
  const s = fitScale(wrap, img) * v.zoom;
  return (wrap.clientWidth - img.naturalWidth * s) / 2 + v.panX;
}
function originY(wrap: HTMLDivElement, img: HTMLImageElement, v: { zoom: number; panY: number }) {
  const s = fitScale(wrap, img) * v.zoom;
  return (wrap.clientHeight - img.naturalHeight * s) / 2 + v.panY;
}
function imgTransform(wrap: HTMLDivElement, img: HTMLImageElement, v: { zoom: number; panX: number; panY: number }) {
  const s = fitScale(wrap, img) * v.zoom;
  const x = originX(wrap, img, v), y = originY(wrap, img, v);
  return `translate(${x}px, ${y}px) scale(${s})`;
}
