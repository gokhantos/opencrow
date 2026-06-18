/**
 * GameSetupStage — displays the game formulation artifact.
 *
 * Renders: game-type badge, move-sequence badge, player persona cards
 * (name + strategy-space count + sample strategies).
 *
 * Null-guards all accesses — gameFormulation may be null while the stage is
 * running or if the session failed before this stage.
 */
import { cn } from "../../../../lib/cn";
import type { GameFormulation } from "../../types";
import type { StageStatus } from "../StagePanel";

// ─── Game-type badge colors ────────────────────────────────────────────────────

const GAME_TYPE_BADGE: Record<string, string> = {
  simultaneous: "bg-accent-subtle text-accent border border-accent/20",
  sequential: "bg-[#7928ca18] text-[#7928ca] border border-[#7928ca33]",
  repeated: "bg-warning-subtle text-warning border border-warning/20",
  bayesian: "bg-[#0ea5e918] text-[#0ea5e9] border border-[#0ea5e933]",
  cooperative: "bg-success-subtle text-success border border-success/20",
  evolutionary: "bg-[#f9731618] text-[#f97316] border border-[#f9731633]",
  stackelberg: "bg-bg-3 text-muted border border-border",
  signaling: "bg-[#14b8a618] text-[#14b8a6] border border-[#14b8a633]",
  mechanism_design: "bg-danger-subtle text-danger border border-danger/20",
};

const MOVE_SEQUENCE_BADGE: Record<string, string> = {
  simultaneous: "bg-bg-3 text-muted border border-border",
  sequential: "bg-bg-3 text-muted border border-border",
  repeated: "bg-bg-3 text-muted border border-border",
};

function gameTypeBadgeClass(gameType: string): string {
  return (
    GAME_TYPE_BADGE[gameType] ??
    "bg-bg-3 text-muted border border-border"
  );
}

function moveSequenceBadgeClass(seq: string): string {
  return (
    MOVE_SEQUENCE_BADGE[seq] ??
    "bg-bg-3 text-muted border border-border"
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface PlayerCardProps {
  readonly player: GameFormulation["players"][number];
}

function PlayerCard({ player }: PlayerCardProps) {
  const strategies = player.strategySpace ?? [];
  const sampleStrategies = strategies.slice(0, 3);
  const remaining = strategies.length - sampleStrategies.length;

  return (
    <div className="bg-bg border border-border rounded-lg px-4 py-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-sm font-semibold text-strong leading-tight">
          {player.name}
        </span>
        <span className="text-xs font-mono text-faint shrink-0 mt-0.5">
          {strategies.length} strateg{strategies.length === 1 ? "y" : "ies"}
        </span>
      </div>

      {sampleStrategies.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {sampleStrategies.map((s, i) => (
            <span
              key={i}
              className="text-xs bg-bg-2 border border-border text-muted px-2 py-0.5 rounded"
            >
              {s}
            </span>
          ))}
          {remaining > 0 && (
            <span className="text-xs text-faint px-1 py-0.5">
              +{remaining} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface GameSetupStageProps {
  readonly gameFormulation: GameFormulation | null;
  readonly status: StageStatus;
}

export function GameSetupStage({ gameFormulation, status }: GameSetupStageProps) {
  if (!gameFormulation) {
    if (status === "running") {
      return (
        <div className="px-5 py-6 text-sm text-muted italic">
          Formulating game structure…
        </div>
      );
    }
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        No game formulation data available.
      </div>
    );
  }

  const players = gameFormulation.players ?? [];

  return (
    <div className="px-5 py-5 space-y-4">
      {/* Meta badges */}
      <div className="flex flex-wrap gap-2 items-center">
        <span
          className={cn(
            "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize",
            gameTypeBadgeClass(gameFormulation.gameType),
          )}
        >
          {gameFormulation.gameType.replace(/_/g, " ")}
        </span>

        <span
          className={cn(
            "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize",
            moveSequenceBadgeClass(gameFormulation.moveSequence),
          )}
        >
          {gameFormulation.moveSequence} moves
        </span>

        <span className="text-xs text-faint">
          {players.length} player{players.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Player cards */}
      {players.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Players
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {players.map((p) => (
              <PlayerCard key={p.id} player={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
