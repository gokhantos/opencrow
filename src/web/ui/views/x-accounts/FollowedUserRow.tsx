import { cn } from "../../lib/cn";
import { formatNumber, timeAgo } from "../../lib/format";

interface FollowedUserRowProps {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly followersCount: number;
  readonly followingCount: number;
  readonly verified: boolean;
  readonly followedAt: number;
  readonly followBack: boolean;
}

/**
 * A single row card for a followed user, extracted from AutoFollow.tsx.
 * Shows avatar initials, name, @username, follower/following counts,
 * and a follow-back status badge.
 */
export function FollowedUserRow({
  username,
  displayName,
  followersCount,
  followingCount,
  verified,
  followedAt,
  followBack,
}: FollowedUserRowProps) {
  const initials = (displayName || username)
    .slice(0, 2)
    .toUpperCase();

  return (
    <a
      className="block px-4 py-3.5 rounded-md bg-bg border border-border border-l-2 border-l-accent transition-colors no-underline text-inherit cursor-pointer hover:bg-bg-2"
      href={`https://x.com/${username}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <div className="w-9 h-9 rounded-full bg-accent-subtle flex items-center justify-center shrink-0">
          <span className="font-mono text-xs font-bold text-accent">
            {initials}
          </span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-mono text-sm font-semibold text-foreground truncate">
                @{username}
              </span>
              {verified && (
                <span className="text-xs text-accent shrink-0">&#10003;</span>
              )}
            </div>
            <span className="font-sans text-xs text-faint shrink-0 ml-2">
              {timeAgo(followedAt)}
            </span>
          </div>

          {displayName && displayName !== username && (
            <div className="font-sans text-xs text-muted mb-1.5 truncate">
              {displayName}
            </div>
          )}

          <div className="flex gap-3 flex-wrap items-center">
            <span className="font-mono text-xs text-faint">
              {formatNumber(followersCount)} followers
            </span>
            <span className="font-mono text-xs text-faint">
              {formatNumber(followingCount)} following
            </span>
            <span
              className={cn(
                "px-2.5 py-0.5 rounded-full font-mono text-xs font-medium border",
                followBack
                  ? "bg-success-subtle text-success border-success"
                  : "bg-bg-2 text-faint border-border",
              )}
            >
              {followBack ? "follows back" : "pending"}
            </span>
          </div>
        </div>
      </div>
    </a>
  );
}
