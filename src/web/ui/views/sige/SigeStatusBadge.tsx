import { cn } from "../../lib/cn";
import { STATUS_LABELS, STATUS_BADGE_STYLES } from "./statusConfig";
import type { SigeSessionStatus } from "./types";

interface SigeStatusBadgeProps {
  readonly status: SigeSessionStatus;
  readonly className?: string;
}

export function SigeStatusBadge({ status, className }: SigeStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold capitalize whitespace-nowrap",
        STATUS_BADGE_STYLES[status],
        className,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
