import { useEffect, useRef } from "react";
import { snapshot } from "./perf";

// Small FPS / frame-cost graph pinned to the top-right of the viewport. It
// reads the shared perf meter on a fixed timer (not rAF — rAF is throttled in
// backgrounded/embedded webviews, and we want a steady readout independent of
// the viewport's own on-demand painting).

const W = 168;          // css px
const H = 56;           // css px graph area
const BARS = 90;        // history bars shown
const MS_60 = 1000 / 60; // 16.67ms
const MS_30 = 1000 / 30; // 33.3ms

export function PerfHud() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round((H + 16) * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H + 16}px`;
    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      const s = snapshot();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H + 16);

      // Panel background.
      ctx.fillStyle = "rgba(15, 17, 21, 0.82)";
      ctx.fillRect(0, 0, W, H + 16);

      // Scale: cap at the larger of 50ms or the recent max so spikes stay
      // visible without flattening the normal range.
      const top = Math.max(50, Math.ceil((s.maxMs + 4) / 10) * 10);
      const ms2y = (ms: number) => H - Math.min(ms, top) / top * H;

      // 60fps / 30fps reference lines.
      ctx.strokeStyle = "rgba(124, 217, 154, 0.35)";
      ctx.beginPath(); ctx.moveTo(0, ms2y(MS_60)); ctx.lineTo(W, ms2y(MS_60)); ctx.stroke();
      ctx.strokeStyle = "rgba(240, 200, 100, 0.30)";
      ctx.beginPath(); ctx.moveTo(0, ms2y(MS_30)); ctx.lineTo(W, ms2y(MS_30)); ctx.stroke();

      // History bars (each = one paint's duration).
      const hist = s.history;
      const shown = Math.min(BARS, hist.length);
      const bw = W / BARS;
      for (let i = 0; i < shown; i++) {
        const ms = hist[hist.length - shown + i];
        const y = ms2y(ms);
        ctx.fillStyle = ms <= MS_60 ? "#5fd08a" : ms <= MS_30 ? "#e8c45f" : "#f0685f";
        const x = W - (shown - i) * bw;
        ctx.fillRect(x, y, Math.max(1, bw - 0.5), H - y);
      }

      // Readout text.
      ctx.fillStyle = "#d8dde6";
      ctx.font = "11px ui-monospace, Consolas, monospace";
      ctx.textBaseline = "middle";
      const fps = s.active ? Math.round(s.fps) : 0;
      const fpsTxt = s.active ? `${fps} fps` : "idle";
      ctx.fillText(fpsTxt, 6, H + 8);
      const msTxt = `${s.lastMs.toFixed(1)} ms  ·  max ${s.maxMs.toFixed(0)}`;
      ctx.textAlign = "right";
      ctx.fillText(msTxt, W - 6, H + 8);
      ctx.textAlign = "left";
    };

    draw();
    const timer = window.setInterval(draw, 100);
    return () => window.clearInterval(timer);
  }, []);

  return <canvas ref={canvasRef} className="perf-hud" />;
}
