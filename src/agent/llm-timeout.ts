/**
 * Per-call LLM timeout.
 *
 * Every LLM call routed through `chat()` (and therefore every SIGE round and
 * pipeline step) gets a hard per-call deadline. Without this a single hung
 * provider HTTP request can wedge an entire autonomous session indefinitely —
 * the only recovery being a manual cancellation. The session-level wall-clock
 * in `src/sige/run.ts` is a backstop; this is the primary defense, and it works
 * even for callers that forget to pass their own AbortSignal.
 *
 * The deadline is enforced by combining any caller-supplied signal with an
 * internal timeout controller via `AbortSignal.any`, so an external abort still
 * cancels the request and the timeout is genuinely wired into the in-flight
 * provider request rather than merely flipping a flag.
 */

/** Default per-call timeout: 3.5 minutes. A single strategic-agent LLM call
 *  should comfortably finish inside this; anything longer is a wedged request. */
export const DEFAULT_LLM_CALL_TIMEOUT_MS = 210_000;

/** Lower bound to guard against a misconfigured tiny/zero timeout. */
const MIN_LLM_CALL_TIMEOUT_MS = 1_000;

/** Typed error thrown when a single LLM call exceeds its deadline. The message
 *  is stable so callers (and tests) can match on it; SIGE's existing per-agent
 *  error handling treats this like any other failed agent and moves on. */
export class LlmCallTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs}ms`);
    this.name = "LlmCallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolve the effective per-call timeout in milliseconds.
 *
 * Precedence: explicit option > `LLM_CALL_TIMEOUT_MS` env var > default.
 * Non-positive / non-finite values fall through to the default; the result is
 * clamped to a sane minimum.
 */
export function resolveLlmCallTimeoutMs(explicitMs?: number): number {
  const fromEnv = Number(process.env.LLM_CALL_TIMEOUT_MS);
  const candidate =
    explicitMs !== undefined && Number.isFinite(explicitMs) && explicitMs > 0
      ? explicitMs
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : DEFAULT_LLM_CALL_TIMEOUT_MS;
  return Math.max(MIN_LLM_CALL_TIMEOUT_MS, candidate);
}

export interface CallDeadline {
  /** Combined signal: external abort OR timeout, whichever fires first. */
  readonly signal: AbortSignal;
  /** Clears the timer. MUST be called when the call settles to avoid leaked
   *  timers / a late abort firing against an already-completed request. */
  readonly clear: () => void;
  /** True once the timeout fired (vs. an external abort). */
  readonly timedOut: () => boolean;
  /** The resolved timeout in ms (for error messages / logging). */
  readonly timeoutMs: number;
}

/**
 * Build a per-call deadline. Combines `external` (if any) with an internal
 * timeout controller. The internal timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function createCallDeadline(
  external: AbortSignal | undefined,
  explicitTimeoutMs?: number,
): CallDeadline {
  const timeoutMs = resolveLlmCallTimeoutMs(explicitTimeoutMs);
  const timeoutController = new AbortController();
  let didTimeout = false;

  const timer = setTimeout(() => {
    didTimeout = true;
    timeoutController.abort(new LlmCallTimeoutError(timeoutMs));
  }, timeoutMs);
  // Don't let the deadline timer hold the event loop open on its own.
  (timer as { unref?: () => void }).unref?.();

  const signal = external
    ? AbortSignal.any([external, timeoutController.signal])
    : timeoutController.signal;

  return {
    signal,
    clear: () => clearTimeout(timer),
    timedOut: () => didTimeout,
    timeoutMs,
  };
}
