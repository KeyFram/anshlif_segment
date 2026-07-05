type Props = {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Small modal for actions that need explicit sign-off — deletion and, crucially,
 *  firing a batch of paid fal calls (the count is shown so nothing runs silently). */
export function ConfirmDialog({
  title, message, confirmLabel, cancelLabel = "Отмена", danger, busy, onConfirm, onCancel,
}: Props) {
  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-msg">{message}</div>
        <div className="confirm-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
