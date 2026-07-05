import { useEffect, useRef, useState } from "react";
import { type Phase, rgbToHex } from "./mask";

type Props = {
  phases: Phase[];
  value: number;                 // current target phase index
  onChange: (i: number) => void;
};

/** Top "foreground colour" box for the lasso / wand tools: shows the current
 *  target phase and opens a dropdown to pick another from the fixed palette.
 *  Selecting with lasso / wand paints with this phase directly (no popup). */
export function TargetPhaseBox({ phases, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);   // open upward when no room below
  const ref = useRef<HTMLDivElement>(null);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next && ref.current) {
        const r = ref.current.getBoundingClientRect();
        const estH = Math.min(320, phases.length * 34 + 12);
        setDropUp(window.innerHeight - r.bottom < estH);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cur = phases[value];
  return (
    <div className="target-box" ref={ref}>
      <span className="lbl">Цель</span>
      <button
        className="target-current"
        onClick={toggle}
        title="Целевая фаза — ею закрашивают лассо и волшебная палочка"
      >
        <span className="swatch" style={{ background: cur ? rgbToHex(cur.color) : "transparent" }} />
        <span className="name">{cur?.name ?? "—"}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className={"target-menu" + (dropUp ? " up" : "")}>
          {phases.map((p, i) => (
            <button
              key={i}
              className={"target-menu-item" + (i === value ? " current" : "")}
              onClick={() => { onChange(i); setOpen(false); }}
            >
              <span className="swatch" style={{ background: rgbToHex(p.color) }} />
              <span className="name">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
