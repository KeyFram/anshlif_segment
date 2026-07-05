/** Thin wrapper around the live-wire worker. Worker stores the edge map,
 *  client just sends seed + bbox per request. */
import LassoWorker from "./liveWire.worker.ts?worker";

export type WandResult = { cost: Uint8Array; x0: number; y0: number; x1: number; y1: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PendingResolver = (data: any) => void;

export class LassoEngine {
  private worker: Worker;
  private pending = new Map<number, PendingResolver>();
  private nextReqId = 1;
  private edgeSet = false;
  w = 0; h = 0;

  constructor() {
    this.worker = new LassoWorker();
    this.worker.onmessage = (e: MessageEvent<{ reqId: number }>) => {
      const resolve = this.pending.get(e.data.reqId);
      if (resolve) {
        this.pending.delete(e.data.reqId);
        resolve(e.data);
      }
    };
    this.worker.onerror = (e) => {
      console.error("[lasso worker] error:", e.message, e.filename, e.lineno);
      // Reject all pending requests so UI doesn't hang.
      for (const [, resolve] of this.pending) resolve(null);
      this.pending.clear();
    };
    this.worker.onmessageerror = (e) => {
      console.error("[lasso worker] messageerror", e);
    };
  }

  /** Sends the edge + colour maps ONCE per image. Both buffers are transferred
   *  — caller should treat grad / rgb as detached after this call. */
  setEdgeMap(grad: Float32Array, rgb: Uint8Array, w: number, h: number) {
    this.w = w; this.h = h;
    this.worker.postMessage(
      { kind: "set-edge", grad, rgb, w, h },
      [grad.buffer, rgb.buffer],
    );
    this.edgeSet = true;
  }

  hasEdgeMap() { return this.edgeSet; }

  async computeFrom(
    seedX: number, seedY: number,
    targetX: number, targetY: number,
    opts: { corridor: number; threshold: number },
    bbox?: { x0: number; y0: number; x1: number; y1: number },
  ): Promise<{ reqId: number; parent: Int32Array }> {
    if (!this.edgeSet) throw new Error("edge map not set");
    // Window is in *corner* coords, which span 0..W and 0..H inclusive.
    const x0 = bbox ? Math.max(0, bbox.x0) : 0;
    const y0 = bbox ? Math.max(0, bbox.y0) : 0;
    const x1 = bbox ? Math.min(this.w, bbox.x1) : this.w;
    const y1 = bbox ? Math.min(this.h, bbox.y1) : this.h;
    const reqId = this.nextReqId++;
    const promise = new Promise<{ parent: Int32Array } | null>((resolve) => this.pending.set(reqId, resolve));
    this.worker.postMessage({
      kind: "request", reqId, seedX, seedY, targetX, targetY,
      corridor: opts.corridor, threshold: opts.threshold,
      x0, y0, x1, y1,
    });
    const data = await promise;
    return { reqId, parent: data?.parent ?? new Int32Array(0) };
  }

  /** Magic-wand minimax flood from (seedX, seedY). Returns the per-pixel edge
   *  cost (0..255) over the given pixel window. */
  async computeWand(
    seedX: number, seedY: number,
    bbox: { x0: number; y0: number; x1: number; y1: number },
  ): Promise<WandResult | null> {
    if (!this.edgeSet) throw new Error("edge map not set");
    const x0 = Math.max(0, Math.min(this.w - 1, bbox.x0));
    const y0 = Math.max(0, Math.min(this.h - 1, bbox.y0));
    const x1 = Math.max(0, Math.min(this.w - 1, bbox.x1));
    const y1 = Math.max(0, Math.min(this.h - 1, bbox.y1));
    const reqId = this.nextReqId++;
    const promise = new Promise<WandResult | null>((resolve) => this.pending.set(reqId, resolve));
    this.worker.postMessage({ kind: "wand", reqId, seedX, seedY, x0, y0, x1, y1 });
    return promise;
  }

  dispose() { this.worker.terminate(); this.pending.clear(); }
}

/** Walk `parent` backwards from corner `(x, y)` to the seed (parent[p] === p).
 *  `w` is the corner-grid width (image width + 1). Returns null if the corner
 *  is outside the computed window (parent === -1). */
export function pathFromParent(parent: Int32Array, w: number, x: number, y: number): { xs: Int32Array; ys: Int32Array } | null {
  const start = y * w + x;
  if (parent[start] === -1) return null;
  let p = start;
  const stack: number[] = [];
  let guard = 0;
  while (true) {
    stack.push(p);
    const par = parent[p];
    if (par < 0 || par === p) break;
    p = par;
    if (++guard > parent.length) break;
  }
  const xs = new Int32Array(stack.length);
  const ys = new Int32Array(stack.length);
  for (let i = 0; i < stack.length; i++) {
    const idx = stack[i];
    ys[i] = (idx / w) | 0;
    xs[i] = idx - ys[i] * w;
  }
  return { xs, ys };
}
