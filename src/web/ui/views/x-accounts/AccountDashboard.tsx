import React, { useState, useEffect } from "react";
import { cn } from "../../lib/cn";
import { AccountHeader } from "./AccountHeader";
import { AutoLikesTab } from "./AutoLikesTab";
import { AutoFollowTab } from "./AutoFollowTab";
import { BookmarksTab } from "./BookmarksTab";
import { TimelineTab } from "./TimelineTab";
import type { XAccount, FeatureTab } from "./types";

interface FeatureTabDef {
  readonly id: FeatureTab;
  readonly label: string;
}

const FEATURE_TABS: ReadonlyArray<FeatureTabDef> = [
  { id: "timeline", label: "Timeline" },
  { id: "auto-likes", label: "Auto Likes" },
  { id: "auto-follow", label: "Auto Follow" },
  { id: "bookmarks", label: "Bookmarks" },
];

interface AccountDashboardProps {
  readonly account: XAccount;
  readonly onVerify: () => void;
  readonly onUpdate: () => void;
  readonly onDelete: () => void;
  readonly verifying?: boolean;
}

export function AccountDashboard({
  account,
  onVerify,
  onUpdate,
  onDelete,
  verifying = false,
}: AccountDashboardProps) {
  const [activeTab, setActiveTab] = useState<FeatureTab>("timeline");

  useEffect(() => {
    setActiveTab("timeline");
  }, [account.id]);

  return (
    <div className="flex flex-col">
      <AccountHeader
        account={account}
        onVerify={onVerify}
        onEdit={onUpdate}
        onDelete={onDelete}
        verifying={verifying}
      />

      {/* Feature tab bar */}
      <div className="flex gap-0 border-b border-border bg-bg-1 overflow-x-auto">
        {FEATURE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-4 py-3 text-sm font-medium border-b-2 transition-colors shrink-0 whitespace-nowrap",
              activeTab === tab.id
                ? "border-accent text-strong"
                : "border-transparent text-muted hover:text-strong",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="p-6">
        {activeTab === "timeline" && (
          <TimelineTab accountId={account.id} />
        )}
        {activeTab === "auto-likes" && (
          <AutoLikesTab accountId={account.id} />
        )}
        {activeTab === "auto-follow" && (
          <AutoFollowTab accountId={account.id} />
        )}
        {activeTab === "bookmarks" && (
          <BookmarksTab accountId={account.id} />
        )}
      </div>
    </div>
  );
}
