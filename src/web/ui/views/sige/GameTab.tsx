import { cn } from "../../lib/cn";
import type { SigeSessionDetail } from "./types";

interface GameTabProps {
  readonly session: SigeSessionDetail;
}

const EQUILIBRIUM_BADGE: Record<string, string> = {
  nash: "bg-accent-subtle text-accent border border-accent/20",
  pareto: "bg-success-subtle text-success border border-success/20",
  dominant: "bg-warning-subtle text-warning border border-warning/20",
  evolutionary_stable: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  signaling_separating: "bg-bg-3 text-muted border border-border",
  signaling_pooling: "bg-bg-3 text-muted border border-border",
};

export function GameTab({ session }: GameTabProps) {
  const { gameFormulation, expertResult } = session;

  if (!gameFormulation && !expertResult) {
    return (
      <div className="py-8 text-sm text-muted italic">
        Game analysis data not yet available.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Game formulation */}
      {gameFormulation && (
        <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold text-strong m-0">
              Game Formulation
            </h3>
          </div>
          <div className="px-5 py-4 space-y-4">
            {/* Meta */}
            <div className="flex flex-wrap gap-2">
              <InfoChip label="Type" value={gameFormulation.gameType} />
              <InfoChip label="Move sequence" value={gameFormulation.moveSequence} />
              <InfoChip label="Players" value={String(gameFormulation.players.length)} />
            </div>

            {/* Players */}
            {gameFormulation.players.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Players
                </p>
                <div className="space-y-2">
                  {gameFormulation.players.map((p) => (
                    <div
                      key={p.id}
                      className="bg-bg border border-border rounded-lg px-4 py-3"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-semibold text-strong">{p.name}</span>
                        <span className="text-xs font-mono text-faint">{p.id}</span>
                      </div>
                      {p.strategySpace.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {p.strategySpace.map((s, i) => (
                            <span
                              key={i}
                              className="text-xs bg-bg-2 border border-border text-muted px-2 py-0.5 rounded"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                      {p.payoffFunction && (
                        <p className="text-xs text-faint mt-2 italic">{p.payoffFunction}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Expert game result */}
      {expertResult && (
        <>
          {/* Equilibria */}
          {expertResult.equilibria.length > 0 && (
            <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-border">
                <h3 className="text-sm font-semibold text-strong m-0">
                  Equilibria Found
                </h3>
              </div>
              <div className="divide-y divide-border">
                {expertResult.equilibria.map((eq, i) => (
                  <div key={i} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <span
                        className={cn(
                          "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize",
                          EQUILIBRIUM_BADGE[eq.type] ??
                            "bg-bg-3 text-muted border border-border",
                        )}
                      >
                        {eq.type.replace(/_/g, " ")}
                      </span>
                      <div className="flex items-center gap-1.5 text-xs text-muted shrink-0">
                        <span>Stability</span>
                        <span className="font-mono font-semibold text-strong">
                          {(eq.stability * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <p className="text-sm text-muted leading-relaxed m-0">
                      {eq.description}
                    </p>
                    {eq.ideas.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {eq.ideas.map((id, j) => (
                          <span
                            key={j}
                            className="text-xs font-mono bg-bg-2 border border-border text-faint px-1.5 py-0.5 rounded"
                          >
                            {id.slice(0, 8)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Meta-game health */}
          <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border">
              <h3 className="text-sm font-semibold text-strong m-0">
                Meta-Game Health
              </h3>
            </div>
            <div className="px-5 py-4 grid grid-cols-3 gap-4">
              <MetricCard
                label="Diversity Index"
                value={(expertResult.metaGameHealth.diversityIndex * 100).toFixed(1) + "%"}
              />
              <MetricCard
                label="Convergence Rate"
                value={(expertResult.metaGameHealth.convergenceRate * 100).toFixed(1) + "%"}
              />
              <MetricCard
                label="Novelty Score"
                value={(expertResult.metaGameHealth.noveltyScore * 100).toFixed(1) + "%"}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function InfoChip({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-bg border border-border rounded-lg px-3 py-1.5">
      <span className="text-xs text-faint">{label}:</span>
      <span className="text-xs font-semibold text-strong capitalize">
        {value.replace(/_/g, " ")}
      </span>
    </div>
  );
}

function MetricCard({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="bg-bg border border-border rounded-lg px-4 py-3 text-center">
      <div className="text-lg font-bold font-mono text-strong mb-0.5">{value}</div>
      <div className="text-xs text-faint">{label}</div>
    </div>
  );
}
