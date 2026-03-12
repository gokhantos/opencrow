import { useState, useEffect, useCallback } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { Pencil, Trash2, Plus } from "lucide-react";
import { apiFetch } from "../api";
import {
  PageHeader,
  LoadingState,
  EmptyState,
  Button,
  Modal,
  Input,
  Toggle,
  FormField,
} from "../components";
import { useZodForm } from "../hooks/useZodForm";
import { cn } from "../lib/cn";

interface RoutingRule {
  readonly id: string;
  readonly channel: string;
  readonly matchType: string;
  readonly matchValue: string;
  readonly agentId: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ruleFormSchema = z.object({
  channel: z.string(),
  matchType: z.string(),
  matchValue: z.string().min(1, "Match value is required"),
  agentId: z.string().min(1, "Agent ID is required"),
  priority: z.number().int(),
  enabled: z.boolean(),
  notes: z.string(),
});

type RuleFormValues = z.infer<typeof ruleFormSchema>;

const EMPTY_FORM: RuleFormValues = {
  channel: "*",
  matchType: "chat",
  matchValue: "",
  agentId: "",
  priority: 0,
  enabled: true,
  notes: "",
};

const TH =
  "text-[10px] font-semibold text-faint uppercase tracking-[0.1em] px-4 py-2.5";

const CHANNEL_COLORS: Record<string, string> = {
  telegram: "blue",
  whatsapp: "green",
  "*": "gray",
};

const TYPE_COLORS: Record<string, string> = {
  chat: "blue",
  user: "green",
  group: "yellow",
  pattern: "gray",
};

const badgeClasses: Record<string, string> = {
  blue: "bg-accent-subtle text-accent",
  green: "bg-success-subtle text-success",
  yellow: "bg-warning-subtle text-warning",
  gray: "bg-bg-3 text-muted",
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap",
        badgeClasses[color] ?? badgeClasses.gray,
      )}
    >
      {label}
    </span>
  );
}

function SelectField({
  label,
  id,
  value,
  onChange,
  options,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div>
      <label
        className="block text-sm font-semibold text-muted uppercase tracking-wide mb-2"
        htmlFor={id}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 bg-bg border border-border-2 rounded-lg text-foreground text-base outline-none transition-colors duration-150 focus:border-accent appearance-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function RuleFormModal({
  rule,
  onClose,
  onSave,
}: {
  rule: RoutingRule | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const [apiError, setApiError] = useState("");
  const isEdit = rule !== null;

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useZodForm(ruleFormSchema, {
    defaultValues: rule
      ? {
          channel: rule.channel,
          matchType: rule.matchType,
          matchValue: rule.matchValue,
          agentId: rule.agentId,
          priority: rule.priority,
          enabled: rule.enabled,
          notes: rule.notes ?? "",
        }
      : EMPTY_FORM,
  });

  useEffect(() => {
    if (rule) {
      reset({
        channel: rule.channel,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        agentId: rule.agentId,
        priority: rule.priority,
        enabled: rule.enabled,
        notes: rule.notes ?? "",
      });
    } else {
      reset(EMPTY_FORM);
    }
  }, [rule, reset]);

  async function onSubmit(values: RuleFormValues) {
    setApiError("");
    try {
      const body = {
        channel: values.channel,
        matchType: values.matchType,
        matchValue: values.matchValue.trim(),
        agentId: values.agentId.trim(),
        priority: values.priority,
        enabled: values.enabled,
        notes: values.notes.trim() || null,
      };
      if (isEdit) {
        await apiFetch(`/api/routing/rules/${rule.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch("/api/routing/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      onSave();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save rule";
      setApiError(msg);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Edit Routing Rule" : "Create Routing Rule"}
    >
      {apiError && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-5">
          {apiError}
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <Controller
            name="channel"
            control={control}
            render={({ field }) => (
              <SelectField
                label="Channel"
                id="rule-channel"
                value={field.value}
                onChange={field.onChange}
                options={[
                  { value: "*", label: "Any (*)" },
                  { value: "telegram", label: "Telegram" },
                  { value: "whatsapp", label: "WhatsApp" },
                ]}
              />
            )}
          />
          <Controller
            name="matchType"
            control={control}
            render={({ field }) => (
              <SelectField
                label="Match Type"
                id="rule-match-type"
                value={field.value}
                onChange={field.onChange}
                options={[
                  { value: "chat", label: "Chat" },
                  { value: "user", label: "User" },
                  { value: "group", label: "Group" },
                  { value: "pattern", label: "Pattern" },
                ]}
              />
            )}
          />
        </div>

        <FormField label="Match Value" id="rule-match-value" error={errors.matchValue}>
          <Input
            id="rule-match-value"
            {...register("matchValue")}
            placeholder="e.g. 12345678 or /hello.*/"
          />
        </FormField>

        <FormField label="Agent ID" id="rule-agent-id" error={errors.agentId}>
          <Input
            id="rule-agent-id"
            {...register("agentId")}
            placeholder="e.g. default or ai-idea-gen"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-4 items-end">
          <FormField label="Priority" id="rule-priority" hint="Higher = checked first">
            <input
              id="rule-priority"
              type="number"
              {...register("priority", { valueAsNumber: true })}
              className="w-full px-4 py-2.5 bg-bg border border-border-2 rounded-lg text-foreground text-base outline-none transition-colors duration-150 focus:border-accent font-mono"
            />
          </FormField>
          <div className="flex items-center gap-3 pb-6">
            <Controller
              name="enabled"
              control={control}
              render={({ field }) => (
                <Toggle
                  checked={field.value}
                  onChange={field.onChange}
                  label="Enabled"
                />
              )}
            />
          </div>
        </div>

        <FormField label="Notes (optional)" id="rule-notes">
          <Input
            id="rule-notes"
            {...register("notes")}
            placeholder="Optional description..."
          />
        </FormField>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {isEdit ? "Save Changes" : "Create Rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteConfirmModal({
  rule,
  onClose,
  onConfirm,
}: {
  rule: RoutingRule;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/api/routing/rules/${rule.id}`, { method: "DELETE" });
      onConfirm();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Delete Rule">
      <p className="text-muted text-sm mb-2">
        Are you sure you want to delete this routing rule?
      </p>
      <div className="bg-bg rounded-lg border border-border px-4 py-3 mb-6">
        <span className="font-mono text-sm text-foreground">
          {rule.matchType}:{rule.matchValue}
        </span>
        <span className="text-faint text-sm ml-2">&rarr; {rule.agentId}</span>
      </div>
      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" loading={deleting} onClick={handleDelete}>
          Delete Rule
        </Button>
      </div>
    </Modal>
  );
}

export default function RoutingRules() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editRule, setEditRule] = useState<RoutingRule | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteRule, setDeleteRule] = useState<RoutingRule | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await apiFetch<{ success: boolean; data: RoutingRule[] }>(
        "/api/routing/rules",
      );
      if (res.success) {
        setRules(res.data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  async function handleToggleEnabled(rule: RoutingRule) {
    const updated = { ...rule, enabled: !rule.enabled };
    setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
    try {
      await apiFetch(`/api/routing/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
    } catch {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
    }
  }

  function handleSaved() {
    setShowCreate(false);
    setEditRule(null);
    fetchRules();
  }

  function handleDeleted() {
    setDeleteRule(null);
    fetchRules();
  }

  if (loading) {
    return <LoadingState message="Loading routing rules..." />;
  }

  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Routing Rules"
        subtitle="Route messages to agents based on channel, chat, or pattern"
        count={rules.length}
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            Add Rule
          </Button>
        }
      />

      {sorted.length === 0 ? (
        <EmptyState description="No routing rules configured. Add a rule to route messages to specific agents." />
      ) : (
        <div className="bg-bg-1 border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={cn(TH, "text-left")}>Channel</th>
                  <th className={cn(TH, "text-left")}>Type</th>
                  <th className={cn(TH, "text-left")}>Match Value</th>
                  <th className={cn(TH, "text-left")}>Agent</th>
                  <th className={cn(TH, "text-right")}>Priority</th>
                  <th className={cn(TH, "text-center")}>Enabled</th>
                  <th className={cn(TH, "text-left")}>Notes</th>
                  <th className={cn(TH, "text-right")}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((rule) => (
                  <tr
                    key={rule.id}
                    className="border-b border-border/30 hover:bg-bg-2/50 transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <Badge
                        label={rule.channel === "*" ? "Any" : rule.channel}
                        color={CHANNEL_COLORS[rule.channel] ?? "gray"}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        label={rule.matchType}
                        color={TYPE_COLORS[rule.matchType] ?? "gray"}
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                      {rule.matchValue}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-foreground text-sm">
                      {rule.agentId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted">
                      {rule.priority}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <Toggle
                        checked={rule.enabled}
                        onChange={() => handleToggleEnabled(rule)}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-muted text-sm max-w-[180px] truncate">
                      {rule.notes ?? "\u2014"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="w-8 h-8 rounded-md bg-transparent border-none text-muted cursor-pointer flex items-center justify-center hover:bg-bg-3 hover:text-foreground transition-colors"
                          onClick={() => setEditRule(rule)}
                          aria-label="Edit rule"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="w-8 h-8 rounded-md bg-transparent border-none text-muted cursor-pointer flex items-center justify-center hover:bg-danger-subtle hover:text-danger transition-colors"
                          onClick={() => setDeleteRule(rule)}
                          aria-label="Delete rule"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(showCreate || editRule !== null) && (
        <RuleFormModal
          rule={editRule}
          onClose={() => {
            setShowCreate(false);
            setEditRule(null);
          }}
          onSave={handleSaved}
        />
      )}

      {deleteRule !== null && (
        <DeleteConfirmModal
          rule={deleteRule}
          onClose={() => setDeleteRule(null)}
          onConfirm={handleDeleted}
        />
      )}
    </div>
  );
}
