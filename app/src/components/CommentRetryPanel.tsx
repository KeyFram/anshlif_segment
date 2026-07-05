import { useState } from "react";

type Props = {
  onRetry: (comment: string) => void;
  busy?: boolean;
};

/** Bottom panel shown in preview once a mask exists: a free-text hint describing
 *  how the phases should look, appended to the prompt on Retry (regeneration). */
export function CommentRetryPanel({ onRetry, busy }: Props) {
  const [comment, setComment] = useState("");
  return (
    <div className="comment-panel">
      <textarea
        className="comment-input"
        placeholder="Опишите, как какая фаза должна выглядеть, если что-то не так — подсказка добавится к промпту при перегенерации…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
      />
      <button
        className="btn-primary comment-retry"
        onClick={() => onRetry(comment)}
        disabled={busy}
        title="Перегенерировать маску (ваша подсказка добавится в конец промпта)"
      >
        {busy ? "Перегенерация…" : "↻ Retry"}
      </button>
    </div>
  );
}
