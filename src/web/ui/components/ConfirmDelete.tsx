import { useState } from "react";
import { Button } from "./Button";

interface ConfirmDeleteProps {
  readonly onConfirm: () => void | Promise<void>;
  readonly buttonLabel?: string;
  readonly confirmLabel?: string;
}

export function ConfirmDelete({
  onConfirm,
  buttonLabel = "Delete",
  confirmLabel = "Are you sure?",
}: ConfirmDeleteProps) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  if (confirming) {
    async function handleConfirm() {
      setLoading(true);
      try {
        await onConfirm();
        setConfirming(false);
      } catch {
        // Keep the confirm UI open so the user can retry or cancel
      } finally {
        setLoading(false);
      }
    }

    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-sm text-muted">{confirmLabel}</span>
        <Button
          variant="danger"
          size="sm"
          onClick={handleConfirm}
          disabled={loading}
          loading={loading}
        >
          Confirm
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={loading}
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant="danger"
      size="sm"
      onClick={() => setConfirming(true)}
    >
      {buttonLabel}
    </Button>
  );
}
