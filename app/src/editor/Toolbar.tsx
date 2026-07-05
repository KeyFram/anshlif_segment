import type { Mode } from "./CanvasView";
import type { Phase } from "./mask";
import { TargetPhaseBox } from "./TargetPhaseBox";

export type Tool = "cursor" | "lasso" | "wand" | "brush" | "colorrange";

export const BRUSH_MIN = 1;
export const BRUSH_MAX = 200;

type Props = {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  tool: Tool;
  onToolChange: (t: Tool) => void;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "error";
  canSave: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  wandThreshold: number;
  onWandThreshold: (v: number) => void;
  wandFillArea: number;
  onWandFillArea: (v: number) => void;
  wandSmooth: number;
  onWandSmooth: (v: number) => void;
  lassoThreshold: number;
  onLassoThreshold: (v: number) => void;
  brushSize: number;
  onBrushSize: (v: number) => void;
  phases: Phase[];
  targetPhaseIdx: number;
  onTargetPhase: (i: number) => void;
};

export function Toolbar({
  mode, onModeChange, tool, onToolChange,
  onSave, saveState, canSave, onUndo, onRedo, canUndo, canRedo,
  wandThreshold, onWandThreshold,
  wandFillArea, onWandFillArea,
  wandSmooth, onWandSmooth,
  lassoThreshold, onLassoThreshold,
  brushSize, onBrushSize,
  phases, targetPhaseIdx, onTargetPhase,
}: Props) {
  const saveLabel =
    saveState === "saving" ? "Сохранение…" :
    saveState === "saved"  ? "Сохранено ✓" :
    saveState === "error"  ? "Ошибка сохранения" :
                             "Автосохранение";

  const isEdit = mode === "edit";
  const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const clampBrush = (v: number) => Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(v)));
  const clampMax = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));

  return (
    <div className="toolbar">
      <div className="seg">
        <button
          className={mode === "preview" ? "active" : ""}
          onClick={() => onModeChange("preview")}
          title="Превью — показывает маску. Пробел — заглянуть под маску на фото."
        >
          Превью
        </button>
        <button
          className={isEdit ? "active" : ""}
          onClick={() => onModeChange("edit")}
          title="Ручное редактирование — фото с векторными контурами и инструментами."
        >
          Ручное редактирование
        </button>
      </div>

      {/* Tools are only meaningful in Edit mode. */}
      {isEdit && (
        <>
          <div className="sep" />
          <div className="seg" title="Инструмент">
            <button
              className={tool === "cursor" ? "active" : ""}
              onClick={() => onToolChange("cursor")}
              title="Курсор (V) — клик по области, чтобы сменить её фазу"
            >
              ↖
            </button>
            <button
              className={tool === "lasso" ? "active" : ""}
              onClick={() => onToolChange("lasso")}
              title="Магнитное лассо (L) — обвести границу, чтобы вырезать область"
            >
              ◌
            </button>
            <button
              className={tool === "wand" ? "active" : ""}
              onClick={() => onToolChange("wand")}
              title="Волшебная палочка (W) — наведи для превью, Shift+колесо — порог, клик — выделить"
            >
              ✦
            </button>
            <button
              className={tool === "brush" ? "active" : ""}
              onClick={() => onToolChange("brush")}
              title="Кисть (B) — красит целевой фазой; Shift+колесо — размер"
            >
              ✎
            </button>
            <button
              className={tool === "colorrange" ? "active" : ""}
              onClick={() => onToolChange("colorrange")}
              title="Цветовой диапазон (C) — пипетками набрать диапазон цветов; панель справа"
            >
              ◉
            </button>
          </div>
        </>
      )}

      {/* Foreground "colour" box — the phase the lasso / wand / brush paints with. */}
      {isEdit && (tool === "lasso" || tool === "wand" || tool === "brush") && phases.length > 0 && (
        <>
          <div className="sep" />
          <TargetPhaseBox phases={phases} value={targetPhaseIdx} onChange={onTargetPhase} />
        </>
      )}

      {isEdit && tool === "lasso" && (
        <>
          <div className="sep" />
          <div className="wand-thresh" title="Контраст привязки: выше — лассо цепляется только за более чёткие границы (Shift+колесо над холстом)">
            <span className="lbl">Контраст</span>
            <input
              type="range" min={0} max={100} step={1}
              value={lassoThreshold}
              onChange={(e) => onLassoThreshold(clampPct(+e.target.value))}
            />
            <input
              type="number" min={0} max={100}
              value={lassoThreshold}
              onChange={(e) => onLassoThreshold(clampPct(+e.target.value))}
            />
          </div>
        </>
      )}

      {isEdit && tool === "wand" && (
        <>
          <div className="sep" />
          <div className="wand-thresh" title="Порог выделения (Shift+колесо над холстом)">
            <span className="lbl">Порог</span>
            <input
              type="range" min={0} max={100} step={1}
              value={wandThreshold}
              onChange={(e) => onWandThreshold(clampPct(+e.target.value))}
            />
            <input
              type="number" min={0} max={100}
              value={wandThreshold}
              onChange={(e) => onWandThreshold(clampPct(+e.target.value))}
            />
          </div>
          <div className="wand-thresh thin" title="Заливать дырки в выделении площадью до N пикселей (0 — не заливать)">
            <span className="lbl">Заливка</span>
            <input
              type="range" min={0} max={50} step={1}
              value={wandFillArea}
              onChange={(e) => onWandFillArea(clampMax(+e.target.value, 50))}
            />
            <input
              type="number" min={0} max={50}
              value={wandFillArea}
              onChange={(e) => onWandFillArea(clampMax(+e.target.value, 50))}
            />
          </div>
          <div className="wand-thresh thin" title="Сглаживание контура выделения — радиус (0 — без сглаживания)">
            <span className="lbl">Сглаж.</span>
            <input
              type="range" min={0} max={10} step={1}
              value={wandSmooth}
              onChange={(e) => onWandSmooth(clampMax(+e.target.value, 10))}
            />
            <input
              type="number" min={0} max={10}
              value={wandSmooth}
              onChange={(e) => onWandSmooth(clampMax(+e.target.value, 10))}
            />
          </div>
        </>
      )}

      {isEdit && tool === "brush" && (
        <>
          <div className="sep" />
          <div className="wand-thresh" title="Размер кисти (Shift+колесо над холстом)">
            <span className="lbl">Размер</span>
            <input
              type="range" min={BRUSH_MIN} max={BRUSH_MAX} step={1}
              value={brushSize}
              onChange={(e) => onBrushSize(clampBrush(+e.target.value))}
            />
            <input
              type="number" min={BRUSH_MIN} max={BRUSH_MAX}
              value={brushSize}
              onChange={(e) => onBrushSize(clampBrush(+e.target.value))}
            />
          </div>
        </>
      )}

      <div className="sep" />
      <button className="tb-btn" disabled={!canUndo} onClick={onUndo} title="Отменить (Ctrl+Z)">↶</button>
      <button className="tb-btn" disabled={!canRedo} onClick={onRedo} title="Повторить (Ctrl+Shift+Z)">↷</button>

      <div className="sep" />
      <button
        className={"tb-text" + (saveState === "saved" ? " ok" : saveState === "error" ? " err" : "")}
        onClick={onSave}
        disabled={!canSave || saveState === "saving"}
        title="Сохраняется автоматически при каждом изменении — клик, чтобы сохранить сейчас (Ctrl+S)"
      >
        {saveLabel}
      </button>

      <span className="tb-hint">
        {isEdit && tool === "lasso"
          ? <>Клик — ставить точки · клик по первой — замкнуть · <kbd>Shift</kbd>+колесо — контраст · <kbd>Esc</kbd> — отмена</>
          : isEdit && tool === "wand"
          ? <>Наведи для превью · <kbd>Shift</kbd>+колесо — порог · клик — выделить</>
          : isEdit && tool === "brush"
          ? <>Тяни, чтобы красить целевой фазой · <kbd>Shift</kbd>+колесо — размер · <kbd>Space</kbd> — заглянуть</>
          : isEdit && tool === "colorrange"
          ? <>Пипетками кликай по цветам · панель справа · <kbd>Shift</kbd>+<kbd>Space</kbd> скрыть выделение</>
          : isEdit
          ? <>Клик по области — сменить её фазу · <kbd>Space</kbd> — заглянуть под маску</>
          : <>Удерживай <kbd>Space</kbd>, чтобы посмотреть оригинал</>}
      </span>
    </div>
  );
}
