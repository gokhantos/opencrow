import { cn } from "../../lib/cn";
import { formatNumber, timeAgo } from "../../lib/format";

interface TweetRowProps {
  readonly tweetId: string;
  readonly authorUsername: string;
  readonly authorVerified?: boolean;
  readonly authorFollowers?: number;
  readonly text: string;
  readonly likes: number;
  readonly retweets: number;
  readonly replies?: number;
  readonly views?: number;
  readonly hasMedia?: boolean;
  readonly scrapedAt?: number;
  readonly source?: string;
  readonly variant?: "default" | "liked";
}

/**
 * A single tweet row card used in scraped/liked tweet lists.
 * The "liked" variant adds a left accent border in danger color.
 * Links directly to the tweet on x.com.
 */
export function TweetRow({
  tweetId,
  authorUsername,
  authorVerified,
  authorFollowers,
  text,
  likes,
  retweets,
  replies,
  views,
  hasMedia,
  scrapedAt,
  source,
  variant = "default",
}: TweetRowProps) {
  const href = `https://x.com/${authorUsername}/status/${tweetId}`;

  return (
    <a
      className={cn(
        "block px-4 py-3.5 rounded-md bg-bg border border-border transition-colors no-underline text-inherit cursor-pointer hover:bg-bg-2",
        variant === "liked" && "border-l-2 border-l-danger",
      )}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-sm font-semibold text-foreground">
            @{authorUsername}
          </span>
          {authorVerified && (
            <span className="text-xs text-accent">&#10003;</span>
          )}
          {authorFollowers != null && (
            <span className="font-mono text-xs text-faint">
              {formatNumber(authorFollowers)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {source != null && (
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-full font-mono text-xs font-semibold uppercase tracking-wide",
                source === "home"
                  ? "bg-accent-subtle text-accent"
                  : "bg-warning-subtle text-warning",
              )}
            >
              {source === "home" ? "home" : "top"}
            </span>
          )}
          {scrapedAt != null && (
            <span className="font-sans text-xs text-faint">
              {timeAgo(scrapedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Tweet text */}
      <div className="font-sans text-sm text-muted leading-relaxed mb-2 break-words line-clamp-3">
        {text}
      </div>

      {/* Engagement stats */}
      <div className="flex gap-3 flex-wrap">
        <span className="font-mono text-xs text-faint" title="Likes">
          &hearts; {formatNumber(likes)}
        </span>
        <span className="font-mono text-xs text-faint" title="Retweets">
          &#8635; {formatNumber(retweets)}
        </span>
        {replies != null && (
          <span className="font-mono text-xs text-faint" title="Replies">
            &#9993; {formatNumber(replies)}
          </span>
        )}
        {views != null && (
          <span className="font-mono text-xs text-faint" title="Views">
            &#9673; {formatNumber(views)}
          </span>
        )}
        {hasMedia && (
          <span className="font-mono text-xs text-accent px-2 py-0.5 rounded-full bg-accent-subtle">
            media
          </span>
        )}
      </div>
    </a>
  );
}
