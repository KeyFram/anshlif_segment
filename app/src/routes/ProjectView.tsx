import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ImageKind, ImageMeta, PhaseFraction, PreviewParams, ProcStatus, Project } from "../../shared/types";
import {
  api, origUrl, tileUrl, normUrl, tileNormUrl, imageMaskUrl, tileMaskUrl,
} from "../api";
import { Explorer, type Sel } from "../components/Explorer";
import { ProjectCanvas } from "../components/ProjectCanvas";
import { ManualEditor } from "../components/ManualEditor";
import { UploadDialog } from "../components/UploadDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ExportDialog } from "../components/ExportDialog";

type SegTarget = { imageId: string; tileId?: string };
type ConfirmState =
  | { kind: "delete"; imageId: string; name: string }
  | { kind: "batch"; count: number }
  | null;

// How many segment calls run at once during a batch. fal is per-call billed
// regardless; concurrency only trades wall-clock for parallel load.
const BATCH_CONCURRENCY = 3;

export function ProjectView() {
  const { id = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sel>(null);
  const [normalize, setNormalize] = useState(true);   // preview normalized image (default on)
  const [falOn, setFalOn] = useState(false);
  const [segmenting, setSegmenting] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const batchCancel = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const doExport = async (opts: { mask: boolean; orig: boolean; overlay: boolean; name: string }) => {
    setExporting(true);
    try {
      const blob = await api.exportProject(id, opts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${opts.name || "export"}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch (e) {
      alert("Экспорт не удался: " + e);
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(() => {
    api.getProject(id)
      .then((p) => { setProject(p); if (!selected && p.images[0]) autoSelect(p, setSelected); })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.getConfig().then((c) => setFalOn(c.falConfigured)).catch(() => {}); }, []);

  const openFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const imgs = Array.from(list).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) setPendingFiles(imgs);
  };

  const doUpload = async (applyAll: boolean, metas: ImageMeta[], kinds: ImageKind[]) => {
    if (!pendingFiles) return;
    setUploading(true);
    try {
      const res = await api.upload(id, pendingFiles, applyAll, metas, kinds);
      setPendingFiles(null);
      const fresh = await api.getProject(id);
      setProject(fresh);
      const first = res.images[0];
      if (first) setSelected(first.kind === "single"
        ? { kind: "image", imageId: first.id }
        : { kind: "panorama", imageId: first.id });
    } catch (e) {
      alert("Не удалось загрузить: " + e);
    } finally {
      setUploading(false);
    }
  };

  const doSegment = async (t: SegTarget, hint?: string) => {
    setSegmenting(true);
    setProject((p) => markStatus(p, t, "processing"));   // optimistic shimmer
    try {
      await api.segment(id, t.imageId, t.tileId, hint);
    } catch (e) {
      alert("Сегментация не удалась: " + e);
    } finally {
      const fresh = await api.getProject(id).catch(() => null);
      if (fresh) setProject(fresh);
      setSegmenting(false);
    }
  };

  // Batch: process every unprocessed item. Confirmed first (never fires silently),
  // count taken from CURRENT state, bounded concurrency, cancellable.
  const runBatch = async () => {
    if (!project) return;
    const targets = unprocessedTargets(project);
    if (!targets.length) return;
    batchCancel.current = false;
    setBatch({ done: 0, total: targets.length });
    let idx = 0, done = 0;
    const worker = async () => {
      while (!batchCancel.current) {
        const i = idx++;
        if (i >= targets.length) return;
        const t = targets[i];
        setProject((p) => markStatus(p, t, "processing"));
        try { await api.segment(id, t.imageId, t.tileId); } catch { /* skip, keep going */ }
        done++;
        setBatch({ done, total: targets.length });
        const fresh = await api.getProject(id).catch(() => null);
        if (fresh) setProject(fresh);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, targets.length) }, worker));
    setBatch(null);
  };

  const askProcessAll = () => {
    if (!project) return;
    const count = unprocessedTargets(project).length;
    if (count > 0) setConfirm({ kind: "batch", count });
  };

  const askDelete = (imageId: string) => {
    const img = project?.images.find((i) => i.id === imageId);
    setConfirm({ kind: "delete", imageId, name: img?.name ?? "" });
  };

  const doDelete = async (imageId: string) => {
    setConfirmBusy(true);
    try {
      await api.deleteImage(id, imageId);
      const fresh = await api.getProject(id);
      setProject(fresh);
      setSelected((s) =>
        s && s.imageId === imageId ? (fresh.images[0] ? defaultSel(fresh.images[0]) : null) : s);
    } catch (e) {
      alert("Не удалось удалить: " + e);
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    openFiles(e.dataTransfer.files);
  };

  if (error) return <div className="pv-error">Ошибка: {error} · <Link to="/">на главную</Link></div>;
  if (!project) return <div className="pv-loading">Загрузка проекта…</div>;

  const view = resolveView(project, selected, normalize);
  const empty = project.images.length === 0;
  const canSegment = falOn && view.segmentTarget && (view.status === "new" || view.status === "error") && !batch;
  const unprocessed = unprocessedTargets(project).length;
  const hasResults = project.images.some((im) =>
    im.kind === "panorama" ? im.tiles?.some((t) => t.status === "done") : im.status === "done");

  return (
    <div className="pv">
      <header className="pv-top">
        <Link to="/" className="pv-back" title="К списку проектов">←</Link>
        <span className="pv-name">{project.name}</span>
        <span className="pv-domain">микроскопия</span>
        <div className="pv-spacer" />
        <label className="pv-toggle switch" title="Показывать нормализованное изображение (убран цветовой каст и экспозиция). Пробел — сырой оригинал / фото под маской.">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          <span className="track"><span className="thumb" /></span>
          <span className="pv-toggle-label">Нормализация</span>
        </label>
        <input
          ref={fileInputRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { openFiles(e.target.files); e.target.value = ""; }}
        />
      </header>

      <div className="pv-body">
        <Explorer
          project={project}
          selected={selected}
          onSelect={setSelected}
          onAddClick={() => fileInputRef.current?.click()}
          onDeleteImage={askDelete}
          onProcessAll={askProcessAll}
          onCancelBatch={() => { batchCancel.current = true; }}
          onExportClick={() => setExportOpen(true)}
          onReportClick={() => window.open(`/api/projects/${id}/report`, "_blank")}
          hasResults={hasResults}
          unprocessedCount={unprocessed}
          canProcess={falOn && unprocessed > 0 && !batch}
          batchRunning={!!batch}
          batchLabel={batch ? `${batch.done}/${batch.total}` : undefined}
        />
        <div
          className={"pv-stage" + (dragOver ? " dragover" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {empty ? (
            <div className="dropzone">
              <div className="dropzone-inner">
                <div className="dz-icon">⇪</div>
                <div className="dz-title">Перетащите изображения сюда</div>
                <div className="dz-sub">или</div>
                <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
                  Выбрать из проводника
                </button>
                <div className="dz-note">
                  одиночные фото и панорамы (большая сторона &gt; 5000px режется на тайлы)
                </div>
              </div>
            </div>
          ) : view.status === "done" && view.itemKey && view.src && view.peekSrc ? (
            <ManualEditor
              projectId={id}
              itemKey={view.itemKey}
              origSrc={view.peekSrc}
              maskSrc={view.src}
              phasesJson={(view.phases ?? []).map((p) => ({ name: p.name, color: p.color }))}
              fractions={view.phases}
              previewParams={view.previewParams}
              onSaveParams={(p) => view.itemKey && api.savePreviewParams(id, view.itemKey, p).catch(() => {})}
              onRetry={(hint) => view.segmentTarget && doSegment(view.segmentTarget, hint)}
              retrying={segmenting}
            />
          ) : (
            <>
              <ProjectCanvas
                src={view.src}
                peekSrc={view.peekSrc}
                viewKey={view.viewKey}
                pending={view.pending}
                pixelated={view.showMask}
                label={view.label}
                panoramaNotice={view.panoramaNotice}
              />

              {/* Segmentation action bar (bottom-centre of the stage). */}
              {canSegment && (
                <div className="seg-bar">
                  {view.status === "error" && <span className="seg-err">Ошибка сегментации.</span>}
                  <button className="btn-primary" disabled={segmenting} onClick={() => doSegment(view.segmentTarget!)}>
                    {segmenting ? "Сегментация…" : view.status === "error" ? "Повторить сегментацию" : "Сегментировать"}
                  </button>
                </div>
              )}
              {view.segmentTarget && !falOn && view.status === "new" && (
                <div className="seg-bar"><span className="seg-err">fal не настроен (нет ключа)</span></div>
              )}
            </>
          )}
          {dragOver && !empty && <div className="drop-hint">Отпустите, чтобы загрузить</div>}
        </div>
      </div>

      {pendingFiles && (
        <UploadDialog
          files={pendingFiles}
          busy={uploading}
          onCancel={() => !uploading && setPendingFiles(null)}
          onSubmit={doUpload}
        />
      )}

      {exportOpen && (
        <ExportDialog
          defaultName={project.name}
          busy={exporting}
          onCancel={() => !exporting && setExportOpen(false)}
          onExport={doExport}
        />
      )}

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title="Удалить изображение?"
          message={<>«{confirm.name}» и все его файлы (тайлы, нормализация, маски) будут удалены безвозвратно.</>}
          confirmLabel="Удалить"
          danger
          busy={confirmBusy}
          onConfirm={() => doDelete(confirm.imageId)}
          onCancel={() => !confirmBusy && setConfirm(null)}
        />
      )}
      {confirm?.kind === "batch" && (
        <ConfirmDialog
          title="Запустить сегментацию?"
          message={
            <>
              Будет отправлено <b>{confirm.count}</b> изображени{plural(confirm.count)} в fal —
              это <b>{confirm.count}</b> платных вызовов (≈ {estMinutes(confirm.count)} мин).
              Ничего не запускается автоматически: подтвердите, что хотите обработать именно столько.
            </>
          }
          confirmLabel={`Запустить (${confirm.count})`}
          onConfirm={() => { setConfirm(null); void runBatch(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function plural(n: number): string {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return "е";
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return "я";
  return "й";
}
function estMinutes(n: number): number {
  return Math.max(1, Math.ceil((n * 30) / BATCH_CONCURRENCY / 60));  // ~30s/call
}

/** Every item still needing segmentation (singles + panorama tiles). */
function unprocessedTargets(p: Project): SegTarget[] {
  const out: SegTarget[] = [];
  for (const img of p.images) {
    if (img.kind === "single") {
      if (img.status === "new" || img.status === "error") out.push({ imageId: img.id });
    } else {
      for (const t of img.tiles ?? []) {
        if (t.status === "new" || t.status === "error") out.push({ imageId: img.id, tileId: t.id });
      }
    }
  }
  return out;
}

function defaultSel(first: Project["images"][number]): Sel {
  return first.kind === "single"
    ? { kind: "image", imageId: first.id }
    : { kind: "panorama", imageId: first.id };
}

// Pick a sensible default selection after (re)load.
function autoSelect(p: Project, set: (s: Sel) => void) {
  const first = p.images[0];
  if (!first) return;
  set(first.kind === "single"
    ? { kind: "image", imageId: first.id }
    : { kind: "panorama", imageId: first.id });
}

/** Immutably set the status of the targeted item (for optimistic UI). */
function markStatus(p: Project | null, t: SegTarget, status: ProcStatus): Project | null {
  if (!p) return p;
  return {
    ...p,
    images: p.images.map((im) => {
      if (im.id !== t.imageId) return im;
      if (t.tileId) {
        return { ...im, tiles: im.tiles?.map((tl) => (tl.id === t.tileId ? { ...tl, status } : tl)) };
      }
      return { ...im, status };
    }),
  };
}

type ResolvedView = {
  src: string | null;
  peekSrc?: string | null;
  viewKey?: string;
  pending: boolean;                 // processing → shimmer
  showMask?: boolean;               // src is a mask (render pixelated)
  label?: string;
  panoramaNotice?: boolean;
  status?: ProcStatus;
  phases?: PhaseFraction[];
  previewParams?: PreviewParams;
  segmentTarget?: SegTarget;
  itemKey?: string;                 // single_<id> | tile_<id> (for save/retry)
};

function resolveView(project: Project, sel: Sel, normalize: boolean): ResolvedView {
  if (!sel) return { src: null, pending: false };
  const img = project.images.find((i) => i.id === sel.imageId);
  if (!img) return { src: null, pending: false };
  if (sel.kind === "panorama") return { src: null, pending: false, panoramaNotice: true, viewKey: `pano_${img.id}` };

  if (sel.kind === "image") {
    const photo = normalize ? normUrl(project.id, img.id) : origUrl(project.id, img.id);
    const done = img.status === "done";
    return {
      src: done ? imageMaskUrl(project.id, img.id) : photo,
      peekSrc: photo,
      viewKey: `img_${img.id}`,
      pending: img.status === "processing",
      showMask: done,
      status: img.status,
      phases: img.phases,
      previewParams: img.previewParams,
      segmentTarget: { imageId: img.id },
      itemKey: `single_${img.id}`,
      label: `${img.name} · ${img.width}×${img.height}${done ? " · маска" : normalize ? " · норм." : ""}`,
    };
  }
  // tile
  const tile = img.tiles?.find((t) => t.id === sel.tileId);
  if (!tile) return { src: null, pending: false };
  const photo = normalize ? tileNormUrl(project.id, tile.id) : tileUrl(project.id, tile.id);
  const done = tile.status === "done";
  return {
    src: done ? tileMaskUrl(project.id, tile.id) : photo,
    peekSrc: photo,
    viewKey: `tile_${tile.id}`,
    pending: tile.status === "processing",
    showMask: done,
    status: tile.status,
    phases: tile.phases,
    previewParams: tile.previewParams,
    segmentTarget: { imageId: img.id, tileId: tile.id },
    itemKey: `tile_${tile.id}`,
    label: `${img.name} · r${tile.row + 1}·c${tile.col + 1} · ${tile.fullBox.w}×${tile.fullBox.h}${done ? " · маска" : normalize ? " · норм." : ""}`,
  };
}
