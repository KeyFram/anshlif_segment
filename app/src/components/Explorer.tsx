import { useState } from "react";
import type { Project, ProjectImage } from "../../shared/types";

export type Sel =
  | { kind: "image"; imageId: string }
  | { kind: "tile"; imageId: string; tileId: string }
  | { kind: "panorama"; imageId: string }
  | null;

type Props = {
  project: Project;
  selected: Sel;
  onSelect: (s: Sel) => void;
  onAddClick: () => void;
  onDeleteImage: (imageId: string) => void;
  onProcessAll: () => void;
  onCancelBatch: () => void;
  onExportClick: () => void;
  onReportClick: () => void;
  hasResults: boolean;         // any done image → export/report enabled
  unprocessedCount: number;    // items (singles + tiles) still to segment
  canProcess: boolean;         // fal on, count > 0, not already running
  batchRunning: boolean;
  batchLabel?: string;         // "K/N" progress while a batch runs
};

const sameSel = (a: Sel, b: Sel) =>
  !!a && !!b && a.kind === b.kind &&
  (a as any).imageId === (b as any).imageId &&
  (a as any).tileId === (b as any).tileId;

/** Processing dot: anything not "done" is pending; "error" is red. */
function StatusDot({ status }: { status: ProjectImage["status"] }) {
  if (status === "done") return null;
  return <span className={"ex-dot " + (status === "error" ? "err" : "proc")} />;
}

export function Explorer({
  project, selected, onSelect, onAddClick,
  onDeleteImage, onProcessAll, onCancelBatch,
  onExportClick, onReportClick, hasResults,
  unprocessedCount, canProcess, batchRunning, batchLabel,
}: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <aside className="explorer">
      <div className="ex-head">Проводник · {project.images.length}</div>
      <div className="ex-scroll">
      {project.images.length === 0 && (
        <div className="ex-empty">Изображений пока нет</div>
      )}
      <ul className="ex-list">
        {project.images.map((img) => {
          if (img.kind === "single") {
            const sel: Sel = { kind: "image", imageId: img.id };
            return (
              <li
                key={img.id}
                className={"ex-item" + (sameSel(selected, sel) ? " active" : "")}
                onClick={() => onSelect(sel)}
              >
                <span className="ex-icon">▪</span>
                <span className="ex-name">{img.name}</span>
                <StatusDot status={img.status} />
                <button
                  className="ex-del" title="Удалить изображение" disabled={batchRunning}
                  onClick={(e) => { e.stopPropagation(); onDeleteImage(img.id); }}
                >×</button>
              </li>
            );
          }
          // Panorama → expandable folder of tiles.
          const isOpen = open[img.id] ?? false;
          const panoSel: Sel = { kind: "panorama", imageId: img.id };
          const tiles = img.tiles ?? [];
          const doneTiles = tiles.filter((t) => t.status === "done").length;
          return (
            <li key={img.id} className="ex-group">
              <div
                className={"ex-item folder" + (sameSel(selected, panoSel) ? " active" : "")}
                onClick={() => onSelect(panoSel)}
              >
                <button
                  className="ex-twisty"
                  onClick={(e) => { e.stopPropagation(); toggle(img.id); }}
                  title={isOpen ? "Свернуть" : "Развернуть"}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <span className="ex-icon">▦</span>
                <span className="ex-name">{img.name}</span>
                <span className="ex-badge">
                  панорама · {doneTiles}/{tiles.length}
                </span>
                <button
                  className="ex-del" title="Удалить панораму со всеми тайлами" disabled={batchRunning}
                  onClick={(e) => { e.stopPropagation(); onDeleteImage(img.id); }}
                >×</button>
              </div>
              {isOpen && tiles.length > 0 && (
                <ul className="ex-tiles">
                  {tiles.map((t) => {
                    const tSel: Sel = { kind: "tile", imageId: img.id, tileId: t.id };
                    return (
                      <li
                        key={t.id}
                        className={"ex-item tile" + (sameSel(selected, tSel) ? " active" : "")}
                        onClick={() => onSelect(tSel)}
                      >
                        <span className="ex-icon">◻</span>
                        <span className="ex-name">r{t.row + 1}·c{t.col + 1}</span>
                        <StatusDot status={t.status} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      </div>

      <div className="ex-footer">
        <button
          className={"ex-process" + (batchRunning ? " running" : "")}
          disabled={!batchRunning && !canProcess}
          onClick={batchRunning ? onCancelBatch : onProcessAll}
          title={batchRunning
            ? "Остановить обработку (текущее изображение доделается)"
            : unprocessedCount === 0
              ? "Все изображения уже обработаны"
              : "Сегментировать все необработанные изображения"}
        >
          {batchRunning
            ? `⏹ Остановить · ${batchLabel}`
            : `▶ Сегментировать всё${unprocessedCount ? ` (${unprocessedCount})` : ""}`}
        </button>
        <button className="ex-add" onClick={onAddClick} disabled={batchRunning}>+ Добавить изображения</button>
        <div className="ex-footer-row">
          <button className="ex-foot-btn" onClick={onExportClick} disabled={!hasResults || batchRunning}
            title={hasResults ? "Скачать маски архивом" : "Нет обработанных изображений"}>⬇ Экспорт</button>
          <button className="ex-foot-btn" onClick={onReportClick} disabled={!hasResults || batchRunning}
            title="Сформировать PDF-отчёт">📄 Оформить отчёт</button>
        </div>
      </div>
    </aside>
  );
}
