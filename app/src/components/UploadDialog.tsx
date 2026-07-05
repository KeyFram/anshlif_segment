import { useEffect, useState } from "react";
import exifr from "exifr";
import { PANORAMA_THRESHOLD, type ImageKind, type ImageMeta, type ShootingParams } from "../../shared/types";

type Props = {
  files: File[];
  onCancel: () => void;
  onSubmit: (applyAll: boolean, metas: ImageMeta[], kinds: ImageKind[]) => void;
  busy?: boolean;
};

const CALIB_HINT =
  "калибровочные данные в датасете отсутствуют, камера бытовая, EXIF без " +
  "привязки к оптике микроскопа, абсолютные площади требуют калибровки, " +
  "которую мы поддерживаем через ввод µm/pixel";

const blankShooting = (): ShootingParams => ({ camera: "", aperture: "", shutter: "", iso: "" });
const blankMeta = (): ImageMeta => ({ umPerPixel: null, shooting: blankShooting(), deposit: "", exif: {} });

/** EXIF exposure time → "1/x s" (or "N s" for long exposures). */
function fmtShutter(t: unknown): string {
  const v = Number(t);
  if (!v || !isFinite(v)) return "";
  if (v >= 1) return `${v} s`;
  return `1/${Math.round(1 / v)} s`;
}

/** Build separate shooting fields + a raw EXIF record. Focal length omitted. */
function exifToShooting(tags: Record<string, unknown> | undefined): { shooting: ShootingParams; exif: Record<string, string> } {
  if (!tags) return { shooting: blankShooting(), exif: {} };
  const exif: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") exif[k] = String(v); };
  put("Make", tags.Make); put("Model", tags.Model);
  put("FNumber", tags.FNumber); put("ExposureTime", tags.ExposureTime);
  put("ISO", tags.ISO ?? (tags as any).ISOSpeedRatings); put("LensModel", tags.LensModel);
  const shooting: ShootingParams = {
    camera: [tags.Make, tags.Model].filter(Boolean).join(" ").trim(),
    aperture: tags.FNumber ? `f/${tags.FNumber}` : "",
    shutter: fmtShutter(tags.ExposureTime),
    iso: (tags.ISO ?? (tags as any).ISOSpeedRatings) ? String(tags.ISO ?? (tags as any).ISOSpeedRatings) : "",
  };
  return { shooting, exif };
}

export function UploadDialog({ files, onCancel, onSubmit, busy }: Props) {
  const n = files.length;
  const [applyAll, setApplyAll] = useState(true);
  const [current, setCurrent] = useState(0);
  const [metas, setMetas] = useState<ImageMeta[]>(() => files.map(blankMeta));
  const [kinds, setKinds] = useState<ImageKind[]>(() => files.map(() => "single"));
  const [urls, setUrls] = useState<string[]>([]);

  // Object URLs created in an effect (not useMemo) so StrictMode's mount/unmount/
  // remount recreates them instead of leaving revoked URLs → broken previews.
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f));
    setUrls(u);
    // Suggest an initial kind from resolution (editable): big side > threshold
    // ⇒ panorama. The user can override — some singles are 6k+.
    let cancelled = false;
    Promise.all(u.map((url) => new Promise<ImageKind>((res) => {
      const im = new Image();
      im.onload = () => res(Math.max(im.naturalWidth, im.naturalHeight) > PANORAMA_THRESHOLD ? "panorama" : "single");
      im.onerror = () => res("single");
      im.src = url;
    }))).then((guesses) => { if (!cancelled) setKinds(guesses); });
    return () => { cancelled = true; u.forEach((x) => URL.revokeObjectURL(x)); };
  }, [files]);

  // Prefill each meta from EXIF once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await Promise.all(files.map(async (f) => {
        const m = blankMeta();
        try {
          const tags = await exifr.parse(f, { pick: [
            "Make", "Model", "FNumber", "ExposureTime", "ISO", "ISOSpeedRatings", "LensModel",
          ] });
          const { shooting, exif } = exifToShooting(tags);
          m.shooting = shooting; m.exif = exif;
        } catch { /* no EXIF — leave blank */ }
        return m;
      }));
      if (!cancelled) setMetas(next);
    })();
    return () => { cancelled = true; };
  }, [files]);

  const viewIdx = applyAll ? 0 : current;
  const editIdx = applyAll ? 0 : current;
  const meta = metas[editIdx] ?? blankMeta();
  const patch = (p: Partial<ImageMeta>) =>
    setMetas((arr) => arr.map((m, i) => (i === editIdx ? { ...m, ...p } : m)));
  const patchShooting = (p: Partial<ShootingParams>) =>
    patch({ shooting: { ...meta.shooting, ...p } });
  const kind = kinds[editIdx] ?? "single";
  const setKind = (k: ImageKind) =>
    setKinds((arr) => arr.map((x, i) => (i === editIdx ? k : x)));

  const submit = () => onSubmit(
    applyAll,
    applyAll ? [metas[0] ?? blankMeta()] : metas,
    applyAll ? [kinds[0] ?? "single"] : kinds,
  );

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          Загрузка изображений
          <span className="dialog-count">{n} шт.</span>
        </div>

        <div className="dialog-body">
          <div className="dialog-preview">
            {urls[viewIdx]
              ? <img src={urls[viewIdx]} alt="" />
              : <div className="dialog-preview-empty">превью…</div>}
            {n > 1 && (
              <div className="dialog-nav">
                <button disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>‹</button>
                <span>{viewIdx + 1} / {n}</span>
                <button disabled={current >= n - 1} onClick={() => setCurrent((c) => Math.min(n - 1, c + 1))}>›</button>
              </div>
            )}
            <div className="dialog-fname">{files[viewIdx]?.name}</div>
          </div>

          <div className="dialog-fields">
            <div className="field">
              <span className="field-label">Тип изображения</span>
              <div className="kind-seg">
                <button
                  className={kind === "single" ? "active" : ""}
                  onClick={() => setKind("single")}
                >Одиночное</button>
                <button
                  className={kind === "panorama" ? "active" : ""}
                  onClick={() => setKind("panorama")}
                >Панорама</button>
              </div>
              <span className="field-note">
                {kind === "panorama"
                  ? "режется на тайлы 2208×1656 с оверлапом"
                  : "обрабатывается целиком (подгон под ближайшее разрешение Qwen)"}
              </span>
            </div>

            <label className="field">
              <span className="field-label">
                µm / pixel
                <span className="info-mark" tabIndex={0} data-hint={CALIB_HINT}>!</span>
              </span>
              <input
                type="number" step="any" min="0" placeholder="напр. 0.35 (необязательно)"
                value={meta.umPerPixel ?? ""}
                onChange={(e) => patch({ umPerPixel: e.target.value === "" ? null : +e.target.value })}
              />
              <span className="field-note">
                без масштаба выводим только проценты; с масштабом — ещё и абсолютные площади
              </span>
            </label>

            <div className="field-group">
              <span className="field-group-title">Условия съёмки</span>
              <div className="field-grid">
                <label className="field">
                  <span className="field-label sm">Камера</span>
                  <input type="text" placeholder="из EXIF"
                    value={meta.shooting.camera}
                    onChange={(e) => patchShooting({ camera: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label sm">Диафрагма</span>
                  <input type="text" placeholder="f/…"
                    value={meta.shooting.aperture}
                    onChange={(e) => patchShooting({ aperture: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label sm">Выдержка</span>
                  <input type="text" placeholder="1/125 s"
                    value={meta.shooting.shutter}
                    onChange={(e) => patchShooting({ shutter: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label sm">ISO</span>
                  <input type="text" placeholder="100"
                    value={meta.shooting.iso}
                    onChange={(e) => patchShooting({ iso: e.target.value })} />
                </label>
              </div>
              <span className="field-note">фокусное не берём — на этих снимках оно недостоверно</span>
            </div>

            <label className="field">
              <span className="field-label">Месторождение</span>
              <input type="text" placeholder="напр. Норильск-1"
                value={meta.deposit}
                onChange={(e) => patch({ deposit: e.target.value })} />
            </label>

            {n > 1 && (
              <label className="field-check">
                <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
                Применить ко всем {n} изображениям
              </label>
            )}
            {n > 1 && !applyAll && (
              <div className="field-hint">Заполните метаданные для каждого изображения — листайте стрелками выше.</div>
            )}
          </div>
        </div>

        <div className="dialog-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Загрузка…" : "Загрузить и обработать"}
          </button>
        </div>
      </div>
    </div>
  );
}
