import { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { apiFetch } from "../../api";
import { LoadingState, EmptyState } from "../../components";
import { TH, TD, formatTvl, formatDate, ChainBadge } from "./shared";

interface HackRow {
  readonly id: string;
  readonly name: string;
  readonly date: number;
  readonly amount_lost: number | null;
  readonly chain: string | null;
  readonly technique: string | null;
  readonly classification: string | null;
}

function hackRowBg(amount: number | null): string {
  if (amount == null) return "";
  if (amount >= 100_000_000) return "bg-danger/5";
  if (amount >= 10_000_000) return "bg-danger/3";
  return "";
}

export default function HacksTab() {
  const [hacks, setHacks] = useState<HackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await apiFetch<{ success: boolean; data: HackRow[] }>(
        "/api/defi/hacks?limit=50",
      );
      if (res.success) setHacks(res.data);
      setError("");
    } catch {
      setError("Failed to load hack data");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState message="Loading hacks..." />;
  if (error)
    return (
      <div className="text-danger text-sm px-4 py-3 rounded-lg bg-danger/5 border border-danger/20">
        {error}
      </div>
    );
  if (hacks.length === 0) return <EmptyState description="No hack data found." />;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-bg-1/50">
            <th className={cn(TH, "text-left")}>Date</th>
            <th className={cn(TH, "text-left")}>Protocol</th>
            <th className={cn(TH, "text-right")}>Amount Lost</th>
            <th className={cn(TH, "text-left max-md:hidden")}>Chain</th>
            <th className={cn(TH, "text-left max-md:hidden")}>Technique</th>
            <th className={cn(TH, "text-left max-md:hidden")}>
              Classification
            </th>
          </tr>
        </thead>
        <tbody>
          {hacks.map((hack, idx) => (
            <tr
              key={hack.id}
              className={cn(
                "border-b border-border/50 hover:bg-bg-1 transition-colors",
                hackRowBg(hack.amount_lost),
              )}
              style={{ animationDelay: `${Math.min(idx * 20, 400)}ms` }}
            >
              <td
                className={cn(
                  TD,
                  "text-left font-mono text-[12px] text-muted tabular-nums",
                )}
              >
                {formatDate(hack.date)}
              </td>
              <td className={cn(TD, "text-left")}>
                <span className="font-semibold text-strong text-[13px]">
                  {hack.name}
                </span>
              </td>
              <td className={cn(TD, "text-right")}>
                <span className="font-mono text-[13px] font-semibold text-danger tabular-nums">
                  {formatTvl(hack.amount_lost)}
                </span>
              </td>
              <td className={cn(TD, "text-left max-md:hidden")}>
                {hack.chain ? <ChainBadge chain={hack.chain} /> : <span className="text-faint">—</span>}
              </td>
              <td
                className={cn(
                  TD,
                  "text-left text-[12px] text-muted max-md:hidden",
                )}
              >
                {hack.technique ?? "—"}
              </td>
              <td
                className={cn(
                  TD,
                  "text-left text-[12px] text-muted max-md:hidden",
                )}
              >
                {hack.classification ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
