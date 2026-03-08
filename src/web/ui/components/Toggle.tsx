import React from "react";
import { cn } from "../lib/cn";

interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  const button = (
    <button
      className={cn(
        "relative w-[38px] h-[22px] rounded-full border-none cursor-pointer p-0 shrink-0 transition-colors duration-200 text-[0px]",
        checked ? "bg-accent" : "bg-bg-3",
        disabled && "opacity-50 cursor-not-allowed",
      )}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      type="button"
      aria-pressed={checked}
      aria-label={label ?? (checked ? "On" : "Off")}
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-all duration-200",
          checked ? "translate-x-4 bg-white" : "translate-x-0 bg-muted",
        )}
      />
      {checked ? "On" : "Off"}
    </button>
  );

  if (label) {
    return (
      <div className="flex items-center gap-2">
        <span>{label}</span>
        {button}
      </div>
    );
  }

  return button;
}
