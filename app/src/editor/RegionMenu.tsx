import { useEffect, useRef } from "react";
import { type Phase, rgbToHex } from "./mask";

type Props = {
  x: number;            // screen px
  y: number;
  phases: Phase[];
  excludeIdx?: number;  // current phase of the region — shown as «current»
  onPick: (newIdx: number) => void;
  onClose: () => void;
};

export function RegionMenu({ x, y, phases, excludeIdx, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="region-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="region-menu-title">Assign phase</div>
      {phases.map((p, i) => (
        <button
          key={i}
          className={"region-menu-item" + (i === excludeIdx ? " current" : "")}
          onClick={() => onPick(i)}
        >
          <span className="swatch" style={{ background: rgbToHex(p.color) }} />
          <span className="name">{p.name}</span>
          {i === excludeIdx && <span className="badge">current</span>}
        </button>
      ))}
    </div>
  );
}
