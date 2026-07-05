import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PYTHON_BIN, pythonEnv } from "./config.ts";
import type { PhaseFraction } from "../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "segment", "segment.py");

export type PhaseResult = PhaseFraction;

// Hard cap: a hung fal request must not leave an item stuck in "processing".
// A warm call is ~10-25s; the first call after a new LoRA can merge slower.
const SEGMENT_TIMEOUT_MS = 240_000;

/** Segment one image via the bundled Python (fal + clean_edges). Writes the
 *  mask PNG to `outputPath` and returns the discovered phases + fractions.
 *  Throws on failure or timeout (the caller marks the item "error"). */
export function segmentImage(inputPath: string, outputPath: string, hint?: string): Promise<{ phases: PhaseResult[] }> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, [SCRIPT, inputPath, outputPath], {
      env: { ...pythonEnv(), SEGMENT_HINT: hint ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "", settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(() => reject(new Error(`segment timed out after ${SEGMENT_TIMEOUT_MS / 1000}s (fal hung?)`)));
    }, SEGMENT_TIMEOUT_MS);

    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => finish(() => reject(e)));
    p.on("close", (code) => finish(() => {
      if (code !== 0) return reject(new Error(`segment.py exit ${code}: ${err.slice(-800)}`));
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}";
      try {
        const parsed = JSON.parse(line) as { phases: PhaseResult[] };
        resolve({ phases: parsed.phases ?? [] });
      } catch (e) {
        reject(new Error(`bad segment output: ${line.slice(0, 300)} (${e})`));
      }
    }));
  });
}
