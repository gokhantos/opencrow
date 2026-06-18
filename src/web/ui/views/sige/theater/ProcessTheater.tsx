/**
 * ProcessTheater — live + completed vertical-timeline view of a SIGE session.
 *
 * Derives each stage's state (waiting / running / done / error) from
 * `session.status` and which artifacts are non-null.  Fetches the knowledge
 * graph lazily (once) when the KG stage is reached.  Auto-scrolls to the
 * active panel on status change (respects prefers-reduced-motion).
 *
 * Props:
 *   session    — SigeSessionDetail passed from SessionDetail (no double-poll)
 *   sessionId  — used for the /graph fetch
 */
import { useEffect, useRef, useState } from "react";
import type { SigeSessionDetail } from "../types";
import type { GraphView } from "../../../../../sige/knowledge/graph-query";
import { fetchSessionGraph } from "../api";
import { StagePanel } from "./StagePanel";
import type { StageStatus } from "./StagePanel";
import { ReportTab } from "../ReportTab";
import { KnowledgeGraphStage } from "./stages/KnowledgeGraphStage";
import { GameSetupStage } from "./stages/GameSetupStage";
import { ExpertGameStage } from "./stages/ExpertGameStage";
import { SocialSimStage } from "./stages/SocialSimStage";
import { ScoredIdeasStage } from "./stages/ScoredIdeasStage";
import type { SigeSessionStatus } from "../types";

// ─── Stage ordering ────────────────────────────────────────────────────────────

type StageKey =
  | "knowledge_construction"
  | "game_formulation"
  | "expert_game"
  | "social_simulation"
  | "scoring";

const STAGE_ORDER: readonly StageKey[] = [
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
];

const STAGE_TITLES: Record<StageKey, string> = {
  knowledge_construction: "Knowledge Graph",
  game_formulation: "Game Setup",
  expert_game: "Expert Game",
  social_simulation: "Social Simulation",
  scoring: "Scored Ideas",
};

// Statuses that indicate we are "past" a given stage (used for done derivation).
// Index in this list corresponds to STAGE_ORDER.
const STAGE_PAST_STATUSES: Record<StageKey, readonly SigeSessionStatus[]> = {
  knowledge_construction: [
    "game_formulation",
    "expert_game",
    "social_simulation",
    "scoring",
    "report_generation",
    "completed",
  ],
  game_formulation: [
    "expert_game",
    "social_simulation",
    "scoring",
    "report_generation",
    "completed",
  ],
  expert_game: [
    "social_simulation",
    "scoring",
    "report_generation",
    "completed",
  ],
  social_simulation: ["scoring", "report_generation", "completed"],
  scoring: ["report_generation", "completed"],
};

// ─── Stage status derivation ───────────────────────────────────────────────────

function deriveStageStatus(
  key: StageKey,
  session: SigeSessionDetail,
): StageStatus {
  const status = session.status;

  // Explicit failure — keep done stages done, mark everything else as error
  if (status === "failed") {
    if (hasArtifact(key, session)) return "done";
    return "error";
  }

  // Cancelled — show whatever completed as done, the rest as waiting
  if (status === "cancelled") {
    return hasArtifact(key, session) ? "done" : "waiting";
  }

  // Done: artifact is non-null OR status is strictly past this stage
  const pastStatuses = STAGE_PAST_STATUSES[key];
  if (
    hasArtifact(key, session) ||
    (pastStatuses as readonly SigeSessionStatus[]).includes(status)
  ) {
    return "done";
  }

  // Running: current status matches this stage
  if (status === key) return "running";

  return "waiting";
}

function hasArtifact(key: StageKey, session: SigeSessionDetail): boolean {
  switch (key) {
    case "knowledge_construction":
      // No direct artifact on the session object for KG; use status progression
      return (
        (
          STAGE_PAST_STATUSES.knowledge_construction as readonly SigeSessionStatus[]
        ).includes(session.status) || session.status === "completed"
      );
    case "game_formulation":
      return session.gameFormulation != null;
    case "expert_game":
      return session.expertResult != null;
    case "social_simulation":
      // fusedScores is the artifact for scoring, not social_simulation;
      // use status progression for social_simulation
      return (
        (
          STAGE_PAST_STATUSES.social_simulation as readonly SigeSessionStatus[]
        ).includes(session.status) || session.status === "completed"
      );
    case "scoring":
      return (session.fusedScores?.length ?? 0) > 0;
  }
}

function stageSummaryStat(
  key: StageKey,
  session: SigeSessionDetail,
  graphView: GraphView | null,
): string | undefined {
  switch (key) {
    case "knowledge_construction":
      if (!graphView) return undefined;
      return `${graphView.nodes.length} entities · ${graphView.edges.length} edges`;
    case "game_formulation":
      if (!session.gameFormulation) return undefined;
      return `${session.gameFormulation.players.length} players · ${session.gameFormulation.gameType}`;
    case "expert_game":
      if (!session.expertResult) return undefined;
      return `${session.expertResult.equilibria.length} equilibria`;
    case "social_simulation":
      return undefined;
    case "scoring":
      return session.fusedScores
        ? `${session.fusedScores.length} ideas scored`
        : undefined;
  }
}

// ─── useGraph hook ─────────────────────────────────────────────────────────────

function useGraph(
  sessionId: string,
  shouldFetch: boolean,
): { graph: GraphView | null; graphError: boolean } {
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [graphError, setGraphError] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!shouldFetch || fetchedRef.current) return;
    fetchedRef.current = true;

    const controller = new AbortController();

    fetchSessionGraph(sessionId, controller.signal)
      .then((g) => {
        if (!controller.signal.aborted) setGraph(g);
      })
      .catch((e: unknown) => {
        if (
          controller.signal.aborted ||
          (e instanceof Error && e.name === "AbortError")
        ) {
          return;
        }
        setGraphError(true);
        // Provide an empty graph so the stage renders the unavailable state
        setGraph({ nodes: [], edges: [], summary: "" });
      });

    return () => controller.abort();
  }, [sessionId, shouldFetch]);

  return { graph, graphError };
}

// ─── ProcessTheater ────────────────────────────────────────────────────────────

export interface ProcessTheaterProps {
  readonly session: SigeSessionDetail;
  readonly sessionId: string;
}

export function ProcessTheater({ session, sessionId }: ProcessTheaterProps) {
  const panelRefs = useRef<Map<StageKey, HTMLDivElement>>(new Map());

  // Determine which stage is currently running (for auto-scroll)
  const activeStage = STAGE_ORDER.find(
    (k) => deriveStageStatus(k, session) === "running",
  );

  // Fetch the knowledge graph lazily once the KG stage is reached
  const kgStageStatus = deriveStageStatus("knowledge_construction", session);
  const kgReached =
    kgStageStatus === "running" ||
    kgStageStatus === "done" ||
    kgStageStatus === "error";
  const { graph: graphView } = useGraph(sessionId, kgReached);

  // Auto-scroll to the active stage panel on status change.
  // matchMedia is called inside the effect to avoid reading it at render time
  // (slow in some envs, cannot track preference changes, and may throw in
  // test environments that do not implement window.matchMedia).
  useEffect(() => {
    if (!activeStage) return;
    const el = panelRefs.current.get(activeStage);
    if (!el) return;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia != null &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      el.scrollIntoView({ block: "start" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [session.status, activeStage]);

  const isCompleted = session.status === "completed";

  return (
    <div className="space-y-4">
      {STAGE_ORDER.map((key, idx) => {
        const status = deriveStageStatus(key, session);
        const summaryStat = stageSummaryStat(key, session, graphView);

        return (
          <div
            key={key}
            ref={(el) => {
              if (el) {
                panelRefs.current.set(key, el);
              } else {
                panelRefs.current.delete(key);
              }
            }}
          >
            <StagePanel
              index={idx + 1}
              title={STAGE_TITLES[key]}
              status={status}
              summaryStat={summaryStat}
            >
              {key === "knowledge_construction" && (
                <KnowledgeGraphStage graphView={graphView} status={status} />
              )}
              {key === "game_formulation" && (
                <GameSetupStage
                  gameFormulation={session.gameFormulation ?? null}
                  status={status}
                />
              )}
              {key === "expert_game" && (
                <ExpertGameStage
                  expertResult={session.expertResult ?? null}
                  status={status}
                />
              )}
              {key === "social_simulation" && (
                <SocialSimStage
                  socialResult={session.socialResult ?? null}
                  status={status}
                />
              )}
              {key === "scoring" && (
                <ScoredIdeasStage
                  fusedScores={session.fusedScores ?? null}
                  status={status}
                />
              )}
            </StagePanel>
          </div>
        );
      })}

      {/* Report section — shown once completed */}
      {isCompleted && session.report && (
        <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <h3 className="text-sm font-semibold text-strong m-0">
              Final Report
            </h3>
          </div>
          <div className="px-5 py-5">
            <ReportTab
              sessionId={sessionId}
              initialReport={session.report}
            />
          </div>
        </div>
      )}
    </div>
  );
}
