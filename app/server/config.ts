import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "..", ".env");   // app/.env

/** Minimal .env loader (KEY=VALUE lines, # comments) — avoids a dependency.
 *  Values already present in process.env win (so deploy env vars override). */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const raw of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !(k in out)) out[k] = v;
    }
  }
  return out;
}

const fileEnv = loadEnv();

/** Read a config value: real process.env first, then app/.env. */
export function cfg(key: string): string | undefined {
  return process.env[key] ?? fileEnv[key];
}

/** True when fal is configured (key + LoRA URL present). */
export function falConfigured(): boolean {
  return !!cfg("FAL_KEY") && !!cfg("LORA_URL");
}

/** Env dict handed to the Python subprocesses. If FAL_PROXY is set (e.g. the
 *  deploy box reaches fal only via a local proxy), it's exported as HTTP(S)_PROXY
 *  so fal_client/requests route through it. Left unset locally (TUN handles it). */
export function pythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    FAL_KEY: cfg("FAL_KEY") ?? "",
    LORA_URL: cfg("LORA_URL") ?? "",
  };
  const proxy = cfg("FAL_PROXY");
  if (proxy) {
    env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; env.ALL_PROXY = proxy;
    env.http_proxy = proxy; env.https_proxy = proxy; env.all_proxy = proxy;
  }
  return env;
}

export const PYTHON_BIN = cfg("PYTHON_BIN") || "python";
