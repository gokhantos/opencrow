/**
 * Pure helpers and types for the append-only idea_feedback event log.
 *
 * The event log is the learning substrate for the ideas pipeline: every
 * pipeline_stage transition and every human signal is recorded immutably.
 * Keeping the stage→kind mapping pure (no DB) lets it be unit-tested in the
 * unit lane and reused by callers that record feedback directly.
 */

export const FEEDBACK_KINDS = [
  "validated",
  "archived",
  "restored",
  "saved",
  "dismissed",
  "built",
  "rated",
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface IdeaFeedbackEvent {
  readonly idea_id: string;
  readonly kind: FeedbackKind;
  readonly rating?: number | null;
  readonly actor?: string | null;
  readonly run_id?: string | null;
  readonly prompt_version?: string | null;
  readonly model?: string | null;
}

export interface IdeaFeedbackRow {
  readonly id: string;
  readonly idea_id: string;
  readonly kind: FeedbackKind;
  readonly rating: number | null;
  readonly actor: string | null;
  readonly run_id: string | null;
  readonly prompt_version: string | null;
  readonly model: string | null;
  readonly created_at: number;
}

/**
 * Map a target pipeline_stage to the feedback event kind that records the
 * transition into that stage. `restored` is not a stage itself (it lands an
 * idea back in the `idea` stage) so it is handled by callers, not here.
 *
 * Returns null for stages that have no meaningful feedback semantics, so
 * callers can skip logging an event for a no-op transition.
 */
export function stageToFeedbackKind(stage: string): FeedbackKind | null {
  switch (stage) {
    case "validated":
      return "validated";
    case "archived":
      return "archived";
    case "idea":
      // Moving (back) to the `idea` stage is a restore signal.
      return "restored";
    default:
      return null;
  }
}

export function isFeedbackKind(value: string): value is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(value);
}
