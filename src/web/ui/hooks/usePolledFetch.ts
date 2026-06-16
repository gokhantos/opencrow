import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { ApiFetchExtras } from "../api";

export interface UsePolledFetchOptions<T> {
  /** Poll interval in milliseconds. */
  readonly intervalMs: number;
  /**
   * When false the hook does nothing (no initial fetch, no interval). Useful
   * for gating polling behind a feature flag or a selected tab.
   */
  readonly enabled?: boolean;
  /**
   * Optional runtime validation / fetch extras forwarded to {@link apiFetch}
   * (e.g. a zod `schema`).
   */
  readonly extras?: ApiFetchExtras<T>;
  /** Extra request options forwarded to {@link apiFetch}. */
  readonly requestInit?: RequestInit;
}

export interface UsePolledFetchResult<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Trigger an out-of-band refetch (e.g. after a mutation). */
  readonly refetch: () => void;
}

/**
 * Polls `path` on a fixed interval while the document is visible.
 *
 * Improvements over the hand-rolled `setInterval(fetch, ms)` pattern that was
 * duplicated across ~27 views:
 *  - Aborts any in-flight request on unmount or before the next poll, so slow
 *    responses can't resolve into an unmounted component.
 *  - Pauses entirely when `document.visibilityState !== "visible"` and fires an
 *    immediate refresh when the tab becomes visible again.
 *  - Centralises error handling and avoids state updates after unmount.
 *
 * The callback that consumes the data is intentionally not part of this hook —
 * callers read `result.data` so derived/accumulated state (e.g. rolling charts)
 * stays in the component.
 */
export function usePolledFetch<T>(
  path: string,
  options: UsePolledFetchOptions<T>,
): UsePolledFetchResult<T> {
  const { intervalMs, enabled = true, extras, requestInit } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep latest option references without forcing the polling effect to restart
  // on every render (which would reset the interval each time).
  const extrasRef = useRef(extras);
  extrasRef.current = extras;
  const requestInitRef = useRef(requestInit);
  requestInitRef.current = requestInit;

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const refetchTokenRef = useRef(0);
  const [refetchSignal, setRefetchSignal] = useState(0);

  const refetch = useCallback(() => {
    refetchTokenRef.current += 1;
    setRefetchSignal((n) => n + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const run = async () => {
      if (document.visibilityState !== "visible") return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await apiFetch<T>(
          path,
          { ...requestInitRef.current, signal: controller.signal },
          extrasRef.current ?? {},
        );
        if (!mountedRef.current || controller.signal.aborted) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Request failed";
        setError(message);
      } finally {
        if (mountedRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    const start = () => {
      if (intervalId !== null) return;
      void run();
      intervalId = setInterval(() => void run(), intervalMs);
    };

    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      abortRef.current?.abort();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [path, intervalMs, enabled, refetchSignal]);

  return { data, error, loading, refetch };
}
