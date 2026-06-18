import React from "react";

interface EmptyStateProps {
  readonly icon?: string;
  readonly title?: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}

export function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      {icon && (
        <div aria-hidden="true" className="w-14 h-14 rounded-xl bg-bg-2 border border-border flex items-center justify-center text-2xl mb-5">
          {icon}
        </div>
      )}
      {title && (
        <div className="text-base font-semibold text-strong mb-1.5">{title}</div>
      )}
      {description && (
        <div className="text-base text-muted max-w-[400px] leading-relaxed">{description}</div>
      )}
      {children}
    </div>
  );
}
