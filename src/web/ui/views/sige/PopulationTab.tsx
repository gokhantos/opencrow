import { useEffect, useState } from "react";
import { LoadingState } from "../../components";
import { cn } from "../../lib/cn";
import { fetchPopulationDynamics } from "./api";
import type { PopulationEntry } from "./types";

interface PopulationTabProps {
  readonly sessionId: string;
}

export function PopulationTab({ sessionId }: PopulationTabProps) {
  const [population, setPopulation] = useState<readonly PopulationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchPopulationDynamics(sessionId)
      .then(setPopulation)
      .catch(() => setError("Failed to load population data."))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <LoadingState message="Loading population data..." />;

  if (error) {
    return <div className="py-8 text-sm text-danger">{error}</div>;
  }

  if (population.length === 0) {
    return (
      <div className="py-8 text-sm text-muted italic">
        No population dynamics data available yet.
      </div>
    );
  }

  // Group by generation
  const byGeneration = population.reduce<Record<number, readonly PopulationEntry[]>>(
    (acc, entry) => {
      const existing = acc[entry.generation] ?? [];
      return { ...acc, [entry.generation]: [...existing, entry] };
    },
    {},
  );

  const generations = Object.keys(byGeneration)
    .map(Number)
    .sort((a, b) => a - b);

  // Find max fitness for bar scaling
  const maxFitness = Math.max(...population.map((p) => p.fitness), 1);

  return (
    <div className="space-y-5">
      {generations.map((gen) => {
        const entries = [...(byGeneration[gen] ?? [])].sort(
          (a, b) => b.fitness - a.fitness,
        );

        return (
          <div
            key={gen}
            className="bg-bg-1 border border-border rounded-xl overflow-hidden"
          >
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-muted uppercase tracking-wide">
                Generation
              </span>
              <span className="text-sm font-bold font-mono text-strong">
                {gen}
              </span>
            </div>

            <div className="divide-y divide-border">
              {entries.map((entry, i) => {
                const barWidth = Math.round((entry.fitness / maxFitness) * 100);
                return (
                  <div
                    key={i}
                    className="px-5 py-3 flex items-center gap-4"
                  >
                    {/* Strategy */}
                    <span className="flex-1 text-sm text-foreground min-w-0 truncate">
                      {entry.strategy}
                    </span>

                    {/* Bar */}
                    <div className="w-32 h-1.5 bg-bg-2 rounded-full overflow-hidden shrink-0">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          i === 0 ? "bg-success" : "bg-accent/60",
                        )}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>

                    {/* Value */}
                    <span className="text-xs font-mono font-semibold text-muted w-16 text-right shrink-0">
                      {entry.fitness.toFixed(4)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
