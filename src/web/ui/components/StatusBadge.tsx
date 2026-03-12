import { cn } from "../lib/cn";

type BadgeVariant = "green" | "red" | "yellow" | "blue" | "gray";

const variantClasses: Record<string, string> = {
  green: "bg-success-subtle text-success",
  red: "bg-danger-subtle text-danger",
  yellow: "bg-warning-subtle text-warning",
  blue: "bg-accent-subtle text-accent",
  gray: "bg-bg-3 text-muted",
};

const dotClasses: Record<string, string> = {
  green: "bg-success",
  red: "bg-danger",
  yellow: "bg-warning",
  blue: "bg-accent",
  gray: "bg-muted",
};

interface StatusBadgeProps {
  readonly status: string;
  readonly variant?: BadgeVariant;
  readonly colorMap?: Readonly<Record<string, string>>;
}

export function StatusBadge({ status, variant, colorMap }: StatusBadgeProps) {
  const resolvedVariant: string = colorMap?.[status] ?? variant ?? "gray";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 px-2.5 py-1 rounded-md font-mono text-sm font-semibold uppercase tracking-wide whitespace-nowrap",
        variantClasses[resolvedVariant] ?? variantClasses.gray,
      )}
    >
      <span className={cn(
        "w-2 h-2 rounded-full",
        dotClasses[resolvedVariant] ?? dotClasses.gray,
      )} />
      {status}
    </span>
  );
}
