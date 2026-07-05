import { randomUUID } from "node:crypto";
import type { Domain, Project, ProjectSummary } from "../shared/types.ts";
import { listProjectIds, readProject, writeProject } from "./storage.ts";

export function createProject(name: string, domain: Domain): Project {
  const project: Project = {
    id: randomUUID().slice(0, 8),
    name: name.trim() || "Без названия",
    domain,
    createdAt: Date.now(),
    images: [],
  };
  writeProject(project);
  return project;
}

export function toSummary(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    domain: p.domain,
    createdAt: p.createdAt,
    imageCount: p.images.length,
    coverImageId: p.images[0]?.id ?? null,
  };
}

export function listSummaries(domain?: Domain): ProjectSummary[] {
  const out: ProjectSummary[] = [];
  for (const id of listProjectIds()) {
    const p = readProject(id);
    if (!p) continue;
    if (domain && p.domain !== domain) continue;
    out.push(toSummary(p));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
