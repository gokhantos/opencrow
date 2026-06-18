import { useState, useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";

interface SystemEvent {
  readonly type: "status";
  readonly data: Record<string, unknown>;
  readonly ts: number;
}

export function useSystemEvents(onEvent?: (event: SystemEvent) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const onEventRef = useRef(onEvent);
  // Guard: set to false in cleanup so a racing ws.onclose after unmount does not
  // call setConnected or schedule a new reconnect (which would cause an unbounded
  // reconnect loop and state-update-on-unmounted-component warnings).
  const mountedRef = useRef(true);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    const { protocol, host } = window.location;
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProtocol}//${host}/ws/system`;
    const token = getToken();

    const ws = token ? new WebSocket(url, token) : new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      attemptsRef.current = 0;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const parsed = JSON.parse(event.data as string) as SystemEvent;
        onEventRef.current?.(parsed);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      // If the hook has been unmounted or the cleanup intentionally closed the
      // socket, bail out immediately — do not reschedule a reconnect.
      if (!mountedRef.current) return;
      setConnected(false);
      const delay = Math.min(1000 * Math.pow(2, attemptsRef.current), 30_000);
      attemptsRef.current++;
      reconnectRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    // Reset guard on (re-)mount so remounting the hook reconnects correctly.
    mountedRef.current = true;
    connect();
    return () => {
      // Mark as unmounted BEFORE closing the socket so the racing onclose
      // handler sees the flag and does not schedule a new reconnect.
      mountedRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      // Belt-and-suspenders: null out handlers so non-spec environments cannot
      // re-enter after close.
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { connected };
}
