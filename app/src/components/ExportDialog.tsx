import { useState } from "react";

type Props = {
  defaultName: string;
  onCancel: () => void;
  onExport: (opts: { mask: boolean; orig: boolean; overlay: boolean; name: string }) => void;
  busy?: boolean;
};

/** Export settings: which variants go into the ZIP. Mask is mandatory; original
 *  and semi-transparent overlay are optional. Panoramas are stitched whole. */
export function ExportDialog({ defaultName, onCancel, onExport, busy }: Props) {
  const [orig, setOrig] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [name, setName] = useState(defaultName);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog export-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Экспорт результатов</div>
        <div className="export-body">
          <div className="export-section">Что положить в архив:</div>
          <label className="field-check disabled">
            <input type="checkbox" checked readOnly />
            Маска фаз <span className="cr-muted">(обязательно)</span>
          </label>
          <label className="field-check">
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
            Полупрозрачное наложение на оригинал
          </label>
          <label className="field-check">
            <input type="checkbox" checked={orig} onChange={(e) => setOrig(e.target.checked)} />
            Оригинал
          </label>

          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">Имя архива</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="export" />
          </label>
          <div className="field-hint">Панорамы склеиваются в целое полотно (не по тайлам).</div>
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className="btn-primary" onClick={() => onExport({ mask: true, orig, overlay, name })} disabled={busy}>
            {busy ? "Готовим архив…" : "Скачать ZIP"}
          </button>
        </div>
      </div>
    </div>
  );
}
