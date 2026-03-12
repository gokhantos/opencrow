import { useState } from "react";
import { Button } from "./Button";

interface ConfirmDeleteProps {
  readonly onConfirm: () => void;
  readonly buttonLabel?: string;
  readonly confirmLabel?: string;
}

export function ConfirmDelete({
  onConfirm,
  buttonLabel = "Delete",
  confirmLabel = "Are you sure?",
}: ConfirmDeleteProps) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-sm text-muted">{confirmLabel}</span>
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
        >
          Confirm
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(false)}
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
