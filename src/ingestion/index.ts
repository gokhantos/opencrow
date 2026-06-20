/**
 * Data ingestion domain.
 *
 * Shared infrastructure that pulls scraped source data into the mem0 knowledge
 * graph (credibility scoring + dedup + freshest-first cursors on a timer). The
 * corpus it populates is read by BOTH the generation pipeline (graph-reasoning)
 * AND SIGE — so this is a first-class top-level domain, independent of `sige`.
 */

export {
  type CredibilityInputs,
  computeCredibility,
  parseInstalls,
  clamp01,
} from "./credibility";
export {
  type QualityGateResult,
  passesQualityGate,
  MIN_CONTENT_LENGTH,
  CREDIBILITY_FLOOR,
  ALPHA_RATIO_MIN,
} from "./quality-gate";
export { normaliseForHash, contentHash, isDuplicate, recordHash } from "./dedup";
export {
  type CompositeCursor,
  type DailyBudget,
  CURSOR_NAMESPACE,
  serializeCursor,
  parseCursor,
  readCursor,
  writeCursor,
  resolveOrInitCursor,
  todayUtc,
  dailyCountKey,
  readDailyCap,
  readDailyCount,
  writeDailyCount,
} from "./cursor";
export { type SourceDefinition, type AnySourceDefinition, SOURCES } from "./sources";
export { type IngestionRuntime, runIngestionCycle } from "./cycle";
