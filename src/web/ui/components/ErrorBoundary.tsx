import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4 text-center px-6 py-12">
          <div className="flex items-center justify-center w-14 h-14 rounded-full bg-danger-subtle border border-danger/20">
            <AlertTriangle size={26} className="text-danger" />
          </div>
          <div>
            <p className="text-base font-semibold text-strong mb-1">
              Something went wrong
            </p>
            <p className="text-sm text-muted max-w-sm">
              {this.state.error.message || "An unexpected error occurred in this view."}
            </p>
          </div>
          <button
            onClick={this.reset}
            className="flex items-center gap-2 px-4 py-2 bg-bg-1 border border-border-2 rounded-lg text-sm text-foreground hover:bg-bg-2 transition-colors cursor-pointer"
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
