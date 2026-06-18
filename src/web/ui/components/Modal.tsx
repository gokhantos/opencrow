import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly children: React.ReactNode;
  readonly width?: string;
}

const FOCUSABLE =
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, width }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    // Capture the element that triggered the modal so we can restore focus on close
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus first focusable element when modal opens
    const el = dialogRef.current;
    if (el) {
      const first = el.querySelectorAll<HTMLElement>(FOCUSABLE)[0];
      first?.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to the trigger element (WCAG 2.4.3)
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-5"
      onClick={onClose}
      style={{ animation: "agFadeIn 0.15s ease-out" }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="bg-bg-1 border border-border-2 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
        style={{
          animation: "agSlideUp 0.2s ease-out",
          ...(width !== undefined ? { width } : {}),
        }}
      >
        {title && (
          <div className="flex justify-between items-center px-6 py-5 border-b border-border">
            <h3 id={titleId} className="text-lg font-bold text-strong m-0 tracking-tight">{title}</h3>
            <button
              className="w-8 h-8 rounded-md bg-transparent border-none text-muted cursor-pointer flex items-center justify-center hover:bg-bg-3 hover:text-foreground transition-colors"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
