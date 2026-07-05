// Lightweight viewport perf meter. The canvas repaints on demand (pan / zoom /
// hover / lasso) rather than via a rAF loop, so a plain rAF FPS counter would
// read ~60 even while the viewport is frozen mid-drag. Instead we time each
// actual paint() and derive both the per-frame cost (ms) and the achieved
// repaint rate (fps) from the spacing between consecutive paints.

const CAP = 240; // ring length (~a few seconds of frames)

// Ring buffers, oldest→newest by (head - count … head).
const durs = new Float32Array(CAP);   // draw duration, ms
const ts = new Float64Array(CAP);     // wall-clock at record, ms (performance.now)
let head = 0;
let count = 0;

/** Called once per actual viewport paint with its duration in ms. */
export function recordPaint(durationMs: number): void {
  durs[head] = durationMs;
  // performance.now is monotonic; fine for intervals.
  ts[head] = performance.now();
  head = (head + 1) % CAP;
  if (count < CAP) count++;
}

export type PerfSnapshot = {
  /** Most recent draw duration, ms. */
  lastMs: number;
  /** Mean draw duration over the recent window, ms. */
  avgMs: number;
  /** Worst draw duration over the recent window, ms. */
  maxMs: number;
  /** Achieved repaint rate (paints/sec) while actively painting. */
  fps: number;
  /** True if a paint happened within the idle threshold. */
  active: boolean;
  /** Recent draw durations, oldest→newest (≤ CAP entries). */
  history: number[];
};

const IDLE_MS = 350;        // no paint for this long → idle (no live fps)
const WINDOW = 90;          // frames considered for avg/max/fps

export function snapshot(): PerfSnapshot {
  const now = performance.now();
  if (count === 0) {
    return { lastMs: 0, avgMs: 0, maxMs: 0, fps: 0, active: false, history: [] };
  }
  const n = Math.min(count, WINDOW);
  const history: number[] = new Array(n);
  let sum = 0, max = 0;
  // Collect the last n samples in chronological order.
  for (let i = 0; i < n; i++) {
    const idx = (head - n + i + CAP * 2) % CAP;
    const d = durs[idx];
    history[i] = d;
    sum += d;
    if (d > max) max = d;
  }
  const lastIdx = (head - 1 + CAP) % CAP;
  const lastMs = durs[lastIdx];
  const active = now - ts[lastIdx] < IDLE_MS;

  // fps from the median gap between recent active paints (robust to a single
  // long idle gap sitting inside the window).
  let fps = 0;
  if (active && n >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) {
      const a = (head - n + i - 1 + CAP * 2) % CAP;
      const b = (head - n + i + CAP * 2) % CAP;
      const g = ts[b] - ts[a];
      if (g > 0 && g < IDLE_MS) gaps.push(g);
    }
    if (gaps.length) {
      gaps.sort((x, y) => x - y);
      const med = gaps[gaps.length >> 1];
      fps = med > 0 ? 1000 / med : 0;
    }
  }
  return { lastMs, avgMs: sum / n, maxMs: max, fps, active, history };
}
