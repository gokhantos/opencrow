import React from "react";
import { Search, X } from "lucide-react";

interface SearchBarProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  placeholder = "Search...",
}: SearchBarProps) {
  return (
    <div className="relative">
      <Search
        size={16}
        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
      />
      <input
        className="w-full py-2.5 pl-10 pr-9 rounded-lg border border-border-2 bg-bg text-foreground text-base outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value.length > 0 && (
        <button
          className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md border-none bg-bg-2 text-muted cursor-pointer flex items-center justify-center p-0 hover:text-strong transition-colors"
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
