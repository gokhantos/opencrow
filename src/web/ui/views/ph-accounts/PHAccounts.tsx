import { useState, useEffect } from "react";
import { apiFetch } from "../../api";
import { Button, LoadingState, EmptyState, PageHeader } from "../../components";
import type {
  PHAccount,
  AccountsResponse,
  AccountResponse,
  MutationResponse,
} from "./types";
import { AccountCreateForm, AccountEditForm, AccountCard } from "./AccountCard";
import { CapabilitiesPanel } from "./CapabilitiesPanel";

export default function PHAccounts() {
  const [accounts, setAccounts] = useState<PHAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<PHAccount | null>(null);
  const [configuringAccount, setConfiguringAccount] =
    useState<PHAccount | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  async function loadAccounts() {
    try {
      const res = await apiFetch<AccountsResponse>("/api/ph/accounts");
      if (res.success) {
        setAccounts(res.data);
      } else {
        setError("Failed to load accounts");
      }
    } catch {
      setError("Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  async function handleVerify(id: string) {
    setVerifyingId(id);
    try {
      const res = await apiFetch<AccountResponse>(
        `/api/ph/accounts/${id}/verify`,
        { method: "POST" },
      );
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
      await apiFetch<MutationResponse>(`/api/ph/accounts/${id}`, {
        method: "DELETE",
      });
      await loadAccounts();
    } catch {
      await loadAccounts();
    }
  }

  if (loading) {
    return <LoadingState message="Loading PH accounts..." />;
  }

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  return (
    <div>
      <PageHeader
        title="PH Accounts"
        subtitle={`${accounts.length} accounts configured`}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setShowCreateForm(true);
              setEditingAccount(null);
            }}
          >
            Add Account
          </Button>
        }
      />

      {showCreateForm && (
        <AccountCreateForm
          onCreated={() => {
            setShowCreateForm(false);
            loadAccounts();
          }}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {editingAccount && (
        <AccountEditForm
          account={editingAccount}
          onSaved={() => {
            setEditingAccount(null);
            loadAccounts();
          }}
          onCancel={() => setEditingAccount(null)}
        />
      )}

      {configuringAccount && (
        <CapabilitiesPanel
          account={configuringAccount}
          onSaved={() => {
            setConfiguringAccount(null);
            loadAccounts();
          }}
          onCancel={() => setConfiguringAccount(null)}
        />
      )}

      {accounts.length === 0 ? (
        <EmptyState description="No ProductHunt accounts configured. Add your first account to get started." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-5 max-md:grid-cols-1">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              verifying={verifyingId === account.id}
              onVerify={() => handleVerify(account.id)}
              onEdit={() => {
                setEditingAccount(account);
                setShowCreateForm(false);
                setConfiguringAccount(null);
              }}
              onConfigure={() => {
                setConfiguringAccount(account);
                setShowCreateForm(false);
                setEditingAccount(null);
              }}
              onDelete={() => handleDelete(account.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
