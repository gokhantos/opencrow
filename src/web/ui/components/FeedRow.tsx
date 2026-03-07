import React from "react";

interface FeedRowProps {
  readonly rank?: number;
  readonly title: string;
  readonly url?: string;
  readonly domain?: string;
  readonly description?: string;
  readonly meta?: React.ReactNode;
  readonly stats?: React.ReactNode;
}

export function FeedRow({ rank, title, url, domain, description, meta, stats }: FeedRowProps) {
  return (
    <div className="grid grid-cols-[3rem_1fr_auto] max-sm:grid-cols-[1fr_auto] items-start gap-4 px-4 py-3.5 rounded-lg text-base transition-colors hover:bg-bg-1">
      {rank !== undefined && (
        <span className="font-mono text-sm font-medium text-faint text-right pt-0.5 max-sm:hidden">
          {rank}
        </span>
      )}

      <div className="min-w-0">
        <div>
          {url ? (
            <a
              className="text-strong no-underline font-medium leading-snug hover:text-accent transition-colors"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {title}
            </a>
          ) : (
            <span className="text-strong font-medium leading-snug">{title}</span>
          )}
          {domain && (
            <span className="text-faint text-sm ml-2">({domain})</span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-sm text-faint line-clamp-2 leading-snug">
            {description}
          </p>
        )}
        {meta && (
          <div className="flex items-center gap-2 mt-1.5 flex-wrap text-sm text-muted">
            {meta}
          </div>
        )}
      </div>

      {stats && (
        <div className="flex items-center gap-3 font-mono text-sm text-muted whitespace-nowrap shrink-0 pt-0.5">
          {stats}
        </div>
      )}
    </div>
  );
}

