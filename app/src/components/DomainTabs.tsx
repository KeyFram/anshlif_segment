import type { Domain } from "../../shared/types";

type Props = {
  value: Domain;
  onChange: (d: Domain) => void;
};

/** Sphere selector at the top of the hub. Currently microscopy only. */
export function DomainTabs({ value, onChange }: Props) {
  return (
    <div className="domain-tabs">
      <button
        className={"domain-tab" + (value === "microscopy" ? " active" : "")}
        onClick={() => onChange("microscopy")}
      >
        Микроскопия
      </button>
    </div>
  );
}
