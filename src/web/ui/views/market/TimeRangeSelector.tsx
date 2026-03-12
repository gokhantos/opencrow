import { cn } from "../../lib/cn";

export interface RangeOption {
  readonly label: string;
  readonly hours: number;
}

interface Props {
  readonly options: readonly RangeOption[];
  readonly value: number;
  readonly onChange: (hours: number) => void;
}

export default function TimeRangeSelector({ options, value, onChange }: Props) {
  return (
    <div className="flex gap-1 mb-2.5">
      {options.map((opt) => (
        <button
          key={opt.hours}
          className={cn(
            "py-1 px-3 border-none rounded-md bg-transparent text-faint font-mono text-sm font-semibold cursor-pointer transition-all duration-150 ease-in-out hover:text-foreground hover:bg-bg-3",
            value === opt.hours && "text-accent bg-accent-subtle",
          )}
          onClick={() => onChange(opt.hours)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export const METRICS_RANGES: readonly RangeOption[] = [
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "14d", hours: 336 },
  { label: "30d", hours: 720 },
];

export const FUNDING_RANGES: readonly RangeOption[] = [
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "14d", hours: 336 },
  { label: "30d", hours: 720 },
  { label: "90d", hours: 2160 },
];

export const LIQUIDATION_RANGES: readonly RangeOption[] = [
  { label: "6h", hours: 6 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
];
