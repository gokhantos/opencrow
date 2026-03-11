import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, getToken } from "../api";
import { PageHeader, LoadingState } from "../components";
import { Send, Trash2, Bot, User, AlertCircle, ChevronDown } from "lucide-react";

/* ───── Types ───── */

interface ChatMessage {
  readonly id?: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp?: number;
}

interface AgentOption {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly isDefault?: boolean;
}

/* ───── WebSocket message shapes ───── */

interface WsProgressEvent {
  readonly type: "tool_start" | "tool_done" | "thinking" | "text_output" | "complete";
  readonly tool?: string;
  readonly summary?: string;
  readonly preview?: string;
  readonly durationMs?: number;
  readonly toolUseCount?: number;
}

interface WsResponseEvent {
  readonly type: "response";
  readonly text: string;
  readonly usage?: Record<string, unknown>;
  readonly toolUseCount?: number;
}

interface WsClearedEvent {
  readonly type: "cleared";
}

interface WsErrorEvent {
  readonly type: "error";
  readonly message: string;
}

type WsInboundEvent = WsProgressEvent | WsResponseEvent | WsClearedEvent | WsErrorEvent;

const CHAT_ID = "web-default";
const WS_RECONNECT_DELAY_MS = 3_000;

/* ───── Chat View ───── */

export default function Chat() {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [agents, setAgents] = useState<readonly AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamText, scrollToBottom]);

  /* ── WebSocket lifecycle ── */

  const connectWs = useCallback(() => {
    if (!isMountedRef.current) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/chat`;
    const token = getToken();

    const ws = new WebSocket(wsUrl, token ? [token] : undefined);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) { ws.close(); return; }
      setWsConnected(true);
      setError(null);
    };

    ws.onmessage = (evt) => {
      if (!isMountedRef.current) return;
      let event: WsInboundEvent;
      try {
        event = JSON.parse(evt.data as string) as WsInboundEvent;
      } catch {
        return;
      }
      handleWsEvent(event);
    };

    ws.onclose = () => {
      if (!isMountedRef.current) return;
      setWsConnected(false);
      // Schedule reconnect
      reconnectTimerRef.current = setTimeout(connectWs, WS_RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      // onclose fires after onerror — let that handle reconnect
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleWsEvent(event: WsInboundEvent): void {
    if (event.type === "tool_start") {
      setToolStatus(`Using ${event.tool ?? "tool"}...`);
    } else if (event.type === "tool_done") {
      setToolStatus(null);
    } else if (event.type === "thinking") {
      setToolStatus("Thinking...");
    } else if (event.type === "text_output" && event.preview) {
      setStreamText(event.preview);
    } else if (event.type === "complete") {
      setToolStatus(null);
    } else if (event.type === "response") {
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: event.text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setStreamText("");
      setToolStatus(null);
      setSending(false);
      textareaRef.current?.focus();
    } else if (event.type === "cleared") {
      setMessages([]);
      setStreamText("");
      setError(null);
    } else if (event.type === "error") {
      setError((event as WsErrorEvent).message ?? "An error occurred");
      setSending(false);
      setStreamText("");
      setToolStatus(null);
    }
  }

  useEffect(() => {
    isMountedRef.current = true;
    connectWs();
    loadMessages();
    loadAgents();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connectWs]);

  /* ── Data loading ── */

  async function loadMessages() {
    try {
      const res = await apiFetch<{
        success: boolean;
        data: ChatMessage[];
      }>(`/api/messages?channel=web&chatId=${CHAT_ID}&limit=100`);
      if (res.success) {
        setMessages(res.data);
      }
    } catch {
      // Fresh session, no messages
    } finally {
      setLoading(false);
    }
  }

  async function loadAgents() {
    try {
      const res = await apiFetch<{
        success: boolean;
        data: AgentOption[];
      }>("/api/agents");
      if (res.success) {
        setAgents(res.data);
        const defaultAgent = res.data.find((a) => a.isDefault);
        if (defaultAgent && !selectedAgent) {
          setSelectedAgent(defaultAgent.id);
        }
      }
    } catch {
      // Non-critical
    }
  }

  /* ── Send message ── */

  function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    if (!wsConnected || wsRef.current?.readyState !== WebSocket.OPEN) {
      setError("Not connected — please wait and try again.");
      return;
    }

    setInput("");
    setError(null);
    setToolStatus(null);
    setSending(true);
    setStreamText("");

    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      wsRef.current!.send(
        JSON.stringify({
          type: "message",
          text,
          chatId: CHAT_ID,
          ...(selectedAgent ? { agentId: selectedAgent } : {}),
        }),
      );
    } catch (err) {
      setError("Failed to send message. Please try again.");
      setSending(false);
    }
  }

  function handleClear() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "clear", chatId: CHAT_ID }));
      } catch {
        setError("Failed to clear chat");
      }
    } else {
      // Fallback: HTTP clear
      apiFetch("/api/chat/clear?chatId=web-default", { method: "POST" })
        .then(() => {
          setMessages([]);
          setStreamText("");
          setError(null);
        })
        .catch(() => setError("Failed to clear chat"));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  if (loading) {
    return <LoadingState message="Loading chat..." />;
  }

  const hasMessages = messages.length > 0 || streamText;

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] max-md:h-[calc(100vh-108px)]">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-xl font-bold text-strong">Chat</h1>
          <p className="text-sm text-muted mt-0.5">
            {wsConnected ? "Talk to your agent directly" : "Connecting..."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection indicator */}
          <span
            className={`w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`}
            title={wsConnected ? "Connected" : "Reconnecting..."}
          />

          {/* Agent selector */}
          <div className="relative">
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="appearance-none bg-bg-1 border border-border-2 rounded-lg px-3 py-2 pr-8 text-sm text-foreground outline-none cursor-pointer hover:border-accent/50 transition-colors"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
          </div>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-3 py-2 bg-bg-1 border border-border-2 rounded-lg text-sm text-muted hover:text-danger hover:border-danger/30 transition-colors cursor-pointer"
            title="Clear chat"
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 min-h-0">
        {!hasMessages && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
              <Bot size={28} className="text-accent" />
            </div>
            <h2 className="text-lg font-semibold text-strong mb-1">Start a conversation</h2>
            <p className="text-sm text-muted max-w-sm">
              Send a message to chat with your agent. It has access to all your configured tools.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
          {messages.map((msg, i) => (
            <MessageBubble key={`${msg.timestamp ?? i}-${msg.role}`} message={msg} />
          ))}

          {/* Streaming text preview */}
          {streamText && (
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center shrink-0 mt-0.5">
                <Bot size={14} className="text-accent" />
              </div>
              <div className="bg-bg-1 border border-border-2 rounded-xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words max-w-[85%]">
                {streamText}
                <span className="inline-block w-1.5 h-4 bg-accent/60 ml-0.5 animate-pulse rounded-sm" />
              </div>
            </div>
          )}

          {/* Tool status */}
          {toolStatus && !streamText && (
            <div className="flex gap-3 items-center">
              <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
                <Bot size={14} className="text-accent" />
              </div>
              <div className="text-sm text-muted italic flex items-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                {toolStatus}
              </div>
            </div>
          )}

          {/* Thinking indicator */}
          {sending && !streamText && !toolStatus && (
            <div className="flex gap-3 items-center">
              <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
                <Bot size={14} className="text-accent" />
              </div>
              <div className="flex items-center gap-1.5 px-4 py-3">
                <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 bg-danger-subtle border border-danger/20 rounded-lg text-sm text-danger max-w-3xl mx-auto">
              <AlertCircle size={16} className="shrink-0" />
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-border pt-4 shrink-0">
        <div className="flex gap-3 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            disabled={sending}
            className="flex-1 bg-bg-1 border border-border-2 rounded-xl px-4 py-3 text-sm text-foreground resize-none outline-none transition-colors focus:border-accent placeholder:text-faint disabled:opacity-50 min-h-[44px] max-h-[160px]"
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending || !wsConnected}
            className="flex items-center justify-center w-11 h-11 bg-accent rounded-xl text-white border-none cursor-pointer hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 self-end"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-xs text-faint text-center mt-2">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}

/* ───── Message Bubble ───── */

function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? "bg-blue-500/15" : "bg-accent/15"
        }`}
      >
        {isUser ? (
          <User size={14} className="text-blue-400" />
        ) : (
          <Bot size={14} className="text-accent" />
        )}
      </div>
      <div
        className={`rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words max-w-[85%] ${
          isUser
            ? "bg-blue-600 text-white rounded-tr-sm"
            : "bg-bg-1 border border-border-2 text-foreground rounded-tl-sm"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}
