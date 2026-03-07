import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "../lib/cn";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

// ─── Context ─────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// ─── Single Toast ─────────────────────────────────────────────────────────────

const VARIANT = {
  success: {
    icon: CheckCircle,
    bar: "bg-success",
    label: "text-success",
  },
  error: {
    icon: XCircle,
    bar: "bg-danger",
    label: "text-danger",
  },
  warning: {
    icon: AlertTriangle,
    bar: "bg-warning",
    label: "text-warning",
  },
  info: {
    icon: Info,
    bar: "bg-accent",
    label: "text-accent",
  },
} as const;

interface ToastCardProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function ToastCard({ item, onDismiss }: ToastCardProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mount → enter
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Auto-dismiss
  useEffect(() => {
    timerRef.current = setTimeout(() => dismiss(), item.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [item.duration]);

  function dismiss() {
    setExiting(true);
    setTimeout(() => onDismiss(item.id), 280);
  }

  const { icon: Icon, bar, label } = VARIANT[item.type];

  return (
    <div
      className={cn(
        "flex items-start gap-3 bg-bg-1 border border-border-2 rounded-xl shadow-xl shadow-black/30 pl-4 pr-3 py-3 min-w-[260px] max-w-[360px] transition-all duration-300",
        visible && !exiting
          ? "opacity-100 translate-x-0"
          : "opacity-0 translate-x-6",
      )}
      role="alert"
      aria-live="assertive"
    >
      {/* Left accent bar */}
      <span className={cn("w-0.5 self-stretch rounded-full shrink-0", bar)} />

      {/* Icon */}
      <Icon size={16} className={cn("mt-0.5 shrink-0", label)} />

      {/* Message */}
      <span className="flex-1 text-sm text-foreground leading-snug">
        {item.message}
      </span>

      {/* Dismiss */}
      <button
        onClick={dismiss}
        className="mt-0.5 shrink-0 w-5 h-5 flex items-center justify-center rounded text-faint hover:text-foreground hover:bg-bg-3 transition-colors cursor-pointer border-none bg-transparent"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", duration = 4000) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, type, message, duration }]);
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value: ToastContextValue = {
    toast: addToast,
    success: (msg, dur) => addToast(msg, "success", dur),
    error: (msg, dur) => addToast(msg, "error", dur),
    warning: (msg, dur) => addToast(msg, "warning", dur),
    info: (msg, dur) => addToast(msg, "info", dur),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Toast container — bottom-right, above everything */}
      <div
        className="fixed bottom-5 right-5 z-[70] flex flex-col gap-2 pointer-events-none"
        aria-label="Notifications"
      >
        {toasts.map((item) => (
          <div key={item.id} className="pointer-events-auto">
            <ToastCard item={item} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
