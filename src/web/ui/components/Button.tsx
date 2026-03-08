import React from "react";
import { cn } from "../lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white font-semibold hover:bg-accent-hover",
  secondary:
    "bg-bg-2 text-foreground border border-border-2 hover:bg-bg-3 hover:border-border-hover",
  ghost: "bg-transparent text-muted hover:text-foreground hover:bg-bg-2",
  danger:
    "bg-danger-subtle text-danger border border-danger/20 hover:bg-danger hover:text-white hover:border-danger",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-sm gap-1.5",
  md: "px-4 py-2.5 text-base gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-medium rounded-lg transition-colors duration-150 cursor-pointer border-none whitespace-nowrap",
        variantStyles[variant],
        sizeStyles[size],
        (disabled || loading) &&
          "opacity-50 cursor-not-allowed pointer-events-none",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      {...props}
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" aria-hidden="true" />
      ) : (
        children
      )}
    </button>
  );
}
