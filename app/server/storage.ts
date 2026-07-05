import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Data lives OUTSIDE app/ so it survives reinstalls and isn't served by Vite.
// app/server → app → nornikel_site → data/
export const DATA_ROOT = path.resolve(__dirname, "..", "..", "data");
export const PROJECTS_ROOT = path.join(DATA_ROOT, "projects");

export const projectDir = (id: string) => path.join(PROJECTS_ROOT, id);
export const origDir = (id: string) => path.join(projectDir(id), "orig");
export const tilesDir = (id: string) => path.join(projectDir(id), "tiles");
export const normDir = (id: string) => path.join(projectDir(id), "norm");
export const masksDir = (id: string) => path.join(projectDir(id), "masks");
export const projectJsonPath = (id: string) => path.join(projectDir(id), "project.json");

export function ensureProjectDirs(id: string) {
  for (const d of [projectDir(id), origDir(id), tilesDir(id), normDir(id), masksDir(id)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function listProjectIds(): string[] {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(projectJsonPath(e.name)))
    .map((e) => e.name);
}

export function readProject(id: string): Project | null {
  const p = projectJsonPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Project;
  } catch {
    return null;
  }
}

export function writeProject(project: Project) {
  ensureProjectDirs(project.id);
  fs.writeFileSync(projectJsonPath(project.id), JSON.stringify(project, null, 2), "utf8");
}

export function deleteProject(id: string) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}
