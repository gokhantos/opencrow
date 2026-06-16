import { Button } from "../../components";

/* ===============================================
   Delete Confirmation Dialog
   =============================================== */
export function DeleteDialog({
  agentName,
  onConfirm,
  onCancel,
}: {
  agentName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] p-6 animate-[agFadeIn_0.15s_ease]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-bg-1 border border-border-2 rounded-xl p-8 max-w-[380px] w-full text-center animate-[agSlideUp_0.25s_ease-out]">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-danger-subtle text-danger mb-5">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </div>
        <h3 className="font-heading text-lg font-semibold text-strong m-0 mb-2.5">
          Delete Agent
        </h3>
        <p className="text-muted text-sm leading-relaxed m-0 mb-6">
          Are you sure you want to delete{" "}
          <strong className="text-strong">{agentName}</strong>? This action
          cannot be undone.
        </p>
        <div className="flex justify-center gap-3">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
