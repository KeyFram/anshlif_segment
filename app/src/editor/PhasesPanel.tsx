import { useEffect, useRef, useState } from "react";
import { type Phase, rgbToHex } from "./mask";
import { PALETTE } from "../../shared/types";

type Props = {
  phases: Phase[];
  /** Add a specific palette phase (chosen from the missing set). */
  onAddPhase: (phase: Phase) => void;
  canAddPhase: boolean;
  /** Influence zones: when on, edits only touch the ticked phases. */
  influenceOn: boolean;
  onToggleInfluence: (v: boolean) => void;
  influenceAllowed: boolean[];        // per phase index — editable?
  onToggleAllowed: (i: number) => void;
};

const sameColor = (a: readonly number[], b: readonly number[]) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function PhasesPanel({
  phases, onAddPhase, canAddPhase,
  influenceOn, onToggleInfluence, influenceAllowed, onToggleAllowed,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAddOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // The phases list scrolls (overflow), which would clip a normal dropdown — so
  // the menu is position:fixed, anchored above the "+" from its screen rect.
  const toggleAdd = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    setAddOpen((o) => !o);
  };

  if (phases.length === 0) {
    return (
      <div className="phases">
        <span style={{ color: "var(--muted)" }}>маска не загружена</span>
      </div>
    );
  }

  // Palette phases not yet present in the mask (matched by colour).
  const missing = PALETTE.filter((pp) => !phases.some((p) => sameColor(p.color, pp.color)));

  return (
    <div className="phases">
      {/* Separate "influence zones" field on the left. */}
      <div className={"influence-field" + (influenceOn ? " on" : "")}>
        <span className="influence-title">Зоны влияния</span>
        <label className="switch" title="Ограничить изменения выбранными фазами">
          <input
            type="checkbox"
            checked={influenceOn}
            onChange={(e) => onToggleInfluence(e.target.checked)}
          />
          <span className="track"><span className="thumb" /></span>
          <span className="state">{influenceOn ? "вкл" : "выкл"}</span>
        </label>
      </div>

      <span className="phases-sep" />

      <div className="phases-list">
        {phases.map((p, i) => {
          const allowed = influenceAllowed[i] === true;
          return (
            <div
              className={"phase-chip"
                + (influenceOn ? " clickable" : "")
                + (influenceOn && !allowed ? " protected" : "")}
              key={i}
              onClick={influenceOn ? () => onToggleAllowed(i) : undefined}
              title={influenceOn
                ? (allowed ? "Влияет — клик, чтобы защитить" : "Защищена — клик, чтобы влиять")
                : p.name}
            >
              {influenceOn && (
                <input
                  type="checkbox"
                  className="phase-influence"
                  checked={allowed}
                  readOnly
                  tabIndex={-1}
                />
              )}
              {/* Fixed palette colour — display only, no picker. */}
              <span className="phase-swatch fixed" style={{ background: rgbToHex(p.color) }} />
              <span className="phase-name-label">{p.name}</span>
            </div>
          );
        })}

        {/* Add a phase from the missing palette entries. */}
        {canAddPhase && missing.length > 0 && (
          <div className="phase-add-wrap" ref={addRef}>
            <button
              ref={btnRef}
              className="phase-add"
              onClick={toggleAdd}
              title="Добавить фазу из палитры"
            >+</button>
            {addOpen && menuPos && (
              <div className="phase-add-menu" style={{ left: menuPos.left, bottom: menuPos.bottom }}>
                {missing.map((pp) => (
                  <button
                    key={pp.name}
                    className="phase-add-item"
                    onClick={() => {
                      onAddPhase({ name: pp.name, color: [...pp.color] as Phase["color"] });
                      setAddOpen(false);
                    }}
                  >
                    <span className="swatch" style={{ background: rgbToHex(pp.color) }} />
                    <span>{pp.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
