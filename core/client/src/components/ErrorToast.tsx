import { useEffect } from "react";

interface Props {
  message: string | null;
  /** Remount/re-trigger animation when the same text repeats. */
  toastKey: number;
  onDismiss: () => void;
  /** Auto-hide after ms; 0 = stay until dismissed. */
  durationMs?: number;
}

/** Top-sliding red error toast — friendly message only (no error codes). */
export function ErrorToast({
  message,
  toastKey,
  onDismiss,
  durationMs = 4200,
}: Props) {
  useEffect(() => {
    if (!message || durationMs <= 0) return;
    const t = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(t);
  }, [message, toastKey, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div className="error-toast" role="alert" key={toastKey}>
      {message}
    </div>
  );
}
