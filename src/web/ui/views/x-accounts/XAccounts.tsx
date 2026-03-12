import { useState, useEffect } from "react";
import { apiFetch } from "../../api";
import { PageHeader, LoadingState, EmptyState } from "../../components";
import { AccountSwitcher } from "./AccountSwitcher";
import { AccountDashboard } from "./AccountDashboard";
import { AddAccountModal } from "./AddAccountModal";
import type { XAccount, AccountsResponse, AccountResponse, MutationResponse } from "./types";

export default function XAccounts() {
  const [accounts, setAccounts] = useState<XAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  async function loadAccounts() {
    try {
      const res = await apiFetch<AccountsResponse>("/api/x/accounts");
      if (res.success) {
        setAccounts(res.data);
        setSelectedAccountId((prev) => {
          const stillExists = res.data.some((a) => a.id === prev);
          if (stillExists) return prev;
          return res.data[0]?.id ?? null;
        });
      }
    } catch {
      // leave existing state on error
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  // Auto-select first account when accounts load
  useEffect(() => {
    if (selectedAccountId === null && accounts.length > 0) {
      setSelectedAccountId(accounts[0]?.id ?? null);
    }
  }, [accounts, selectedAccountId]);

  async function handleVerify(id: string) {
    setVerifyingId(id);
    try {
      const res = await apiFetch<AccountResponse>(`/api/x/accounts/${id}/verify`, {
        method: "POST",
      });
      if (res.success) {
        setAccounts((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      }
    } catch {
      await loadAccounts();
    } finally {
      setVerifyingId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiFetch<MutationResponse>(`/api/x/accounts/${id}`, {
        method: "DELETE",
      });
    } catch {
      // fall through to reload
    } finally {
      setSelectedAccountId((prev) => {
        if (prev !== id) return prev;
        const remaining = accounts.filter((a) => a.id !== id);
        return remaining[0]?.id ?? null;
      });
      await loadAccounts();
    }
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

  if (loading) {
    return <LoadingState message="Loading X accounts..." />;
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="X / Twitter"
        subtitle={`${accounts.length} account${accounts.length === 1 ? "" : "s"} configured`}
      />

      <AccountSwitcher
        accounts={accounts}
        selectedId={selectedAccountId}
        onSelect={setSelectedAccountId}
        onAddAccount={() => setShowAddModal(true)}
      />

      {selectedAccount ? (
        <AccountDashboard
          account={selectedAccount}
          onVerify={() => handleVerify(selectedAccount.id)}
          onUpdate={loadAccounts}
          onDelete={() => handleDelete(selectedAccount.id)}
          verifying={verifyingId === selectedAccount.id}
        />
      ) : (
        <EmptyState
          title="No X accounts"
          description="Add your first X account to get started."
        />
      )}

      <AddAccountModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={loadAccounts}
      />
    </div>
  );
}
