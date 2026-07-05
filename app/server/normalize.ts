import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normDir, projectDir } from "./storage.ts";
import { PYTHON_BIN, pythonEnv } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "normalize", "normalize_v4.py");

export type NormTask = { src: string; key: string };

/** Normalize a batch of images (colour-cast + exposure → reference) with the
 *  bundled Python (normalize_v4.py). Runs the script's folder mode ONCE so its
 *  own 12-worker pool does the parallelism — far cheaper than spawning Python
 *  per file. Output lands at norm/<key>.jpg. Failures are non-fatal: the norm
 *  endpoints fall back to the raw original, so the toggle never breaks. */
export async function normalizeBatch(projectId: string, tasks: NormTask[]): Promise<void> {
  if (tasks.length === 0) return;
  const inDir = path.join(projectDir(projectId), "_norm_in");
  const outDir = path.join(projectDir(projectId), "_norm_out");
  fs.rmSync(inDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Stage each source under a flat, key-named copy so the script's output
  // (always <basename>.jpg) maps back to norm/<key>.jpg deterministically.
  let staged = 0;
  for (const t of tasks) {
    if (!fs.existsSync(t.src)) { console.error("[norm] src missing:", t.src); continue; }
    fs.copyFileSync(t.src, path.join(inDir, t.key + path.extname(t.src)));
    staged++;
  }
  console.log(`[norm] ${staged}/${tasks.length} staged in ${inDir}`);

  try {
    const r = await runPython([SCRIPT, inDir, outDir]);
    console.log(`[norm] python exit=${r.code} out=${r.out.slice(-300).trim()} err=${r.err.slice(-300).trim()}`);
    console.log(`[norm] outDir contents: ${fs.existsSync(outDir) ? fs.readdirSync(outDir).join(",") : "(missing)"}`);
    const nd = normDir(projectId);
    fs.mkdirSync(nd, { recursive: true });
    let moved = 0;
    for (const t of tasks) {
      const produced = path.join(outDir, `${t.key}.jpg`);
      if (fs.existsSync(produced)) { fs.renameSync(produced, path.join(nd, `${t.key}.jpg`)); moved++; }
    }
    console.log(`[norm] moved ${moved}/${tasks.length} to norm/`);
  } catch (e) {
    console.error("normalize failed (norm previews will fall back to originals):", e);
  } finally {
    fs.rmSync(inDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/** Normalize ONE whole image (file→file). Used for panoramas: we normalize the
 *  full panorama once, then cut tiles from it — so tiles share a single global
 *  colour/exposure correction (seamless, and matches the training set). */
export async function normalizeWhole(srcPath: string, dstPath: string): Promise<boolean> {
  try {
    await runPython([SCRIPT, srcPath, dstPath]);
    return fs.existsSync(dstPath);
  } catch (e) {
    console.error("normalizeWhole failed:", e);
    return false;
  }
}

function runPython(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, args, {
      // NORMALIZE_SERIAL: multiprocessing pool doesn't spawn under SYSTEM/session 0.
      env: { ...pythonEnv(), NORMALIZE_SERIAL: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ code: code ?? 0, out, err });
      else reject(new Error(`python exit ${code}: ${err.slice(-500)} | out: ${out.slice(-300)}`));
    });
  });
}
