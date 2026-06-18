import React from "react";
import { cn } from "../lib/cn";

interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** Accessible label — required; this button contains only an icon. */
  readonly "aria-label": string;
  readonly className?: string;
}

/**
 * A real <button type="button"> wrapper for icon-only buttons.
 * Requires aria-label at the TypeScript level to ensure accessibility.
 *
 * Usage:
 *   <IconButton aria-label="Close panel" onClick={close}><X size={16} /></IconButton>
 */
export function IconButton({
  "aria-label": ariaLabel,
  className,
  disabled,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors duration-150 cursor-pointer bg-transparent border-none",
        disabled && "opacity-50 cursor-not-allowed pointer-events-none",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
