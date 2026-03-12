import { cn } from "../../lib/cn";
import type { XAccount } from "./types";

const statusDotClass: Record<string, string> = {
  active: "bg-success",
  error: "bg-warning",
  expired: "bg-danger",
  unverified: "bg-muted",
};

interface AccountTabProps {
  readonly account: XAccount;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function AccountTab({ account, selected, onSelect }: AccountTabProps) {
  const displayName = account.display_name ?? account.label;
  const initials = (account.username ?? displayName)
    .replace(/^@/, "")
    .slice(0, 2)
    .toUpperCase();
  const dotClass = statusDotClass[account.status] ?? "bg-muted";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-t-md border-b-2 transition-colors shrink-0 min-w-0",
        selected
          ? "bg-bg-1 border-accent text-strong"
          : "bg-bg-2 border-transparent text-muted hover:bg-bg-1 hover:text-foreground",
      )}
    >
      <div className="w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-xs shrink-0 bg-accent-subtle text-accent border border-border overflow-hidden">
        {account.profile_image_url ? (
          <img
            src={account.profile_image_url}
            alt={displayName}
            className="w-full h-full object-cover"
          />
        ) : (
          initials
        )}
      </div>
      <span className="font-mono text-sm truncate max-w-[120px]">
        {account.username ? `@${account.username}` : account.label}
      </span>
      <span className={cn("w-2 h-2 rounded-full shrink-0", dotClass)} />
    </button>
  );
}

interface AccountSwitcherProps {
  readonly accounts: ReadonlyArray<XAccount>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onAddAccount: () => void;
}

export function AccountSwitcher({
  accounts,
  selectedId,
  onSelect,
  onAddAccount,
}: AccountSwitcherProps) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border pb-0 mb-0">
      {accounts.map((account) => (
        <AccountTab
          key={account.id}
          account={account}
          selected={account.id === selectedId}
          onSelect={() => onSelect(account.id)}
        />
      ))}
      <button
        type="button"
        onClick={onAddAccount}
        className="flex items-center justify-center w-9 h-9 shrink-0 rounded-t-md border-b-2 border-transparent bg-bg-2 text-muted hover:bg-bg-1 hover:text-foreground transition-colors self-end"
        aria-label="Add account"
      >
        <span className="text-lg leading-none">+</span>
      </button>
    </div>
  );
}
