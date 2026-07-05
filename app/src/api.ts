import type {
  Domain, ImageKind, ImageMeta, PreviewParams, Project, ProjectImage, ProjectSummary,
} from "../shared/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: (domain: Domain) =>
    fetch(`/api/projects?domain=${domain}`).then(json<ProjectSummary[]>),

  createProject: (name: string, domain: Domain) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, domain }),
    }).then(json<Project>),

  getProject: (id: string) =>
    fetch(`/api/projects/${id}`).then(json<Project>),

  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then(json<{ ok: boolean }>),

  deleteImage: (id: string, imageId: string) =>
    fetch(`/api/projects/${id}/images/${imageId}`, { method: "DELETE" })
      .then(json<{ ok: boolean }>),

  upload: (
    id: string,
    files: File[],
    applyAll: boolean,
    metas: ImageMeta[],
    kinds: ImageKind[],
  ) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    fd.append("payload", JSON.stringify({ applyAll, metas, kinds }));
    return fetch(`/api/projects/${id}/upload`, { method: "POST", body: fd })
      .then(json<{ images: ProjectImage[]; project: ProjectSummary }>);
  },

  getConfig: () => fetch("/api/config").then(json<{ falConfigured: boolean }>),

  segment: (id: string, imageId: string, tileId?: string, hint?: string) =>
    fetch(`/api/projects/${id}/segment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageId, tileId, hint }),
    }).then(json<{ ok: boolean; imageId: string; tileId?: string }>),

  savePreviewParams: (id: string, key: string, params: PreviewParams) =>
    fetch(`/api/projects/${id}/previewparams/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then(json<{ ok: boolean }>),

  exportProject: async (
    id: string,
    opts: { mask: boolean; orig: boolean; overlay: boolean; name?: string },
  ): Promise<Blob> => {
    const res = await fetch(`/api/projects/${id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.blob();
  },
};

// Image byte URLs (served by Express, proxied through Vite).
export const origUrl = (projectId: string, imageId: string) =>
  `/api/projects/${projectId}/orig/${imageId}`;
export const tileUrl = (projectId: string, tileId: string) =>
  `/api/projects/${projectId}/tile/${tileId}`;
// Normalized variants (fall back to the raw original server-side).
export const normUrl = (projectId: string, imageId: string) =>
  `/api/projects/${projectId}/norm/${imageId}`;
export const tileNormUrl = (projectId: string, tileId: string) =>
  `/api/projects/${projectId}/tilenorm/${tileId}`;
// Segmentation masks (404 until segmented).
export const imageMaskUrl = (projectId: string, imageId: string) =>
  `/api/projects/${projectId}/imagemask/${imageId}`;
export const tileMaskUrl = (projectId: string, tileId: string) =>
  `/api/projects/${projectId}/tilemask/${tileId}`;
