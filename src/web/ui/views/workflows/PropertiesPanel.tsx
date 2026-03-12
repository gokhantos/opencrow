import React, { useEffect, useState } from "react";
import type { Node } from "@xyflow/react";
import { apiFetch } from "../../api";
import type { WorkflowAction } from "./useWorkflowReducer";
import type {
  WorkflowNodeData,
  AgentOption,
  SkillOption,
  ToolOption,
  TriggerNodeData,
  AgentNodeData,
  ToolNodeData,
  SkillNodeData,
  ConditionNodeData,
  TransformNodeData,
  OutputNodeData,
} from "./types";

interface PropsPanelProps {
  readonly node: Node<WorkflowNodeData>;
  readonly dispatch: React.Dispatch<WorkflowAction>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-1.5">
      {children}
    </label>
  );
}

function FieldInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 bg-bg border border-border-2 rounded-md text-sm text-foreground outline-none focus:border-accent transition-colors placeholder:text-faint"
    />
  );
}

function FieldSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-bg border border-border-2 rounded-md text-sm text-foreground outline-none focus:border-accent transition-colors appearance-none cursor-pointer"
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FieldTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-3 py-2 bg-bg border border-border-2 rounded-md text-sm text-foreground outline-none focus:border-accent transition-colors placeholder:text-faint resize-none font-mono"
    />
  );
}

function TriggerProperties({
  data,
  onChange,
}: {
  data: TriggerNodeData;
  onChange: (partial: Partial<TriggerNodeData>) => void;
}) {
  const TRIGGER_TYPES = [
    { value: "manual", label: "Manual" },
    { value: "cron", label: "Cron" },
    { value: "webhook", label: "Webhook" },
  ] as const;

  return (
    <>
      <div className="mb-4">
        <Label>Trigger Type</Label>
        <FieldSelect
          value={data.triggerType}
          onChange={(v) =>
            onChange({ triggerType: v as "cron" | "webhook" | "manual" })
          }
          options={TRIGGER_TYPES}
        />
      </div>
      {data.triggerType === "cron" && (
        <div className="mb-4">
          <Label>Cron Expression</Label>
          <FieldInput
            value={data.cronExpression ?? ""}
            onChange={(v) => onChange({ cronExpression: v })}
            placeholder="0 * * * *"
          />
        </div>
      )}
      {data.triggerType === "webhook" && (
        <div className="mb-4">
          <Label>Webhook Path</Label>
          <FieldInput
            value={data.webhookPath ?? ""}
            onChange={(v) => onChange({ webhookPath: v })}
            placeholder="/webhook/my-flow"
          />
        </div>
      )}
    </>
  );
}

function AgentProperties({
  data,
  onChange,
}: {
  data: AgentNodeData;
  onChange: (partial: Partial<AgentNodeData>) => void;
}) {
  const [agents, setAgents] = useState<AgentOption[]>([]);

  useEffect(() => {
    apiFetch<{ data: AgentOption[] }>("/api/agents")
      .then((res) => setAgents(res.data))
      .catch(() => setAgents([]));
  }, []);

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));

  return (
    <>
      <div className="mb-4">
        <Label>Agent</Label>
        <FieldSelect
          value={data.agentId}
          onChange={(v) => {
            const agent = agents.find((a) => a.id === v);
            onChange({ agentId: v, agentName: agent?.name ?? v });
          }}
          options={agentOptions}
          placeholder="Select agent..."
        />
      </div>
      <div className="mb-4">
        <Label>Prompt Override</Label>
        <FieldTextarea
          value={data.prompt ?? ""}
          onChange={(v) => onChange({ prompt: v })}
          placeholder="Optional prompt to pass to the agent..."
          rows={4}
        />
      </div>
    </>
  );
}

function ToolProperties({
  data,
  onChange,
}: {
  data: ToolNodeData;
  onChange: (partial: Partial<ToolNodeData>) => void;
}) {
  const [tools, setTools] = useState<ToolOption[]>([]);

  useEffect(() => {
    apiFetch<{ data: ToolOption[]; success: boolean }>("/api/tools")
      .then((res) => setTools(res.data))
      .catch(() => setTools([]));
  }, []);

  const toolOptions = tools.map((t) => ({ value: t.name, label: t.name }));

  return (
    <>
      <div className="mb-4">
        <Label>Tool</Label>
        {toolOptions.length > 0 ? (
          <FieldSelect
            value={data.toolName}
            onChange={(v) => onChange({ toolName: v })}
            options={toolOptions}
            placeholder="Select tool..."
          />
        ) : (
          <FieldInput
            value={data.toolName}
            onChange={(v) => onChange({ toolName: v })}
            placeholder="tool_name"
          />
        )}
      </div>
      <div className="mb-4">
        <Label>Input Mapping (JSON)</Label>
        <FieldTextarea
          value={data.inputMapping ?? ""}
          onChange={(v) => onChange({ inputMapping: v })}
          placeholder='{"query": "{{input}}"}'
          rows={3}
        />
      </div>
    </>
  );
}

function SkillProperties({
  data,
  onChange,
}: {
  data: SkillNodeData;
  onChange: (partial: Partial<SkillNodeData>) => void;
}) {
  const [skills, setSkills] = useState<SkillOption[]>([]);

  useEffect(() => {
    apiFetch<{ data: SkillOption[] }>("/api/skills")
      .then((res) => setSkills(res.data))
      .catch(() => setSkills([]));
  }, []);

  const skillOptions = skills.map((s) => ({ value: s.id, label: s.name }));

  return (
    <div className="mb-4">
      <Label>Skill</Label>
      <FieldSelect
        value={data.skillId}
        onChange={(v) => {
          const skill = skills.find((s) => s.id === v);
          onChange({ skillId: v, skillName: skill?.name ?? v });
        }}
        options={skillOptions}
        placeholder="Select skill..."
      />
    </div>
  );
}

function ConditionProperties({
  data,
  onChange,
}: {
  data: ConditionNodeData;
  onChange: (partial: Partial<ConditionNodeData>) => void;
}) {
  return (
    <div className="mb-4">
      <Label>Expression</Label>
      <FieldTextarea
        value={data.expression}
        onChange={(v) => onChange({ expression: v })}
        placeholder="output.score > 0.8"
        rows={3}
      />
      <p className="text-[11px] text-muted mt-1.5">
        True edge runs when expression is truthy.
      </p>
    </div>
  );
}

function TransformProperties({
  data,
  onChange,
}: {
  data: TransformNodeData;
  onChange: (partial: Partial<TransformNodeData>) => void;
}) {
  return (
    <div className="mb-4">
      <Label>Template</Label>
      <FieldTextarea
        value={data.template}
        onChange={(v) => onChange({ template: v })}
        placeholder="Hello {{name}}!"
        rows={5}
      />
    </div>
  );
}

function OutputProperties({
  data,
  onChange,
}: {
  data: OutputNodeData;
  onChange: (partial: Partial<OutputNodeData>) => void;
}) {
  const ACTION_OPTS = [
    { value: "return", label: "Return result" },
    { value: "send_channel", label: "Send to channel" },
  ] as const;

  return (
    <>
      <div className="mb-4">
        <Label>Action</Label>
        <FieldSelect
          value={data.action}
          onChange={(v) =>
            onChange({ action: v as "return" | "send_channel" })
          }
          options={ACTION_OPTS}
        />
      </div>
      {data.action === "send_channel" && (
        <div className="mb-4">
          <Label>Channel ID</Label>
          <FieldInput
            value={data.channelId ?? ""}
            onChange={(v) => onChange({ channelId: v })}
            placeholder="telegram"
          />
        </div>
      )}
    </>
  );
}

export function PropertiesPanel({ node, dispatch }: PropsPanelProps) {
  const data = node.data;

  function handleLabelChange(label: string) {
    dispatch({
      type: "UPDATE_NODE_DATA",
      id: node.id,
      data: { ...data, label } as WorkflowNodeData,
    });
  }

  function handleChange(partial: Partial<WorkflowNodeData>) {
    dispatch({
      type: "UPDATE_NODE_DATA",
      id: node.id,
      data: { ...data, ...partial } as WorkflowNodeData,
    });
  }

  return (
    <aside className="w-64 shrink-0 bg-bg-1 border-l border-border flex flex-col overflow-y-auto">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider m-0">
          Properties
        </h3>
      </div>
      <div className="p-4">
        <div className="mb-4">
          <Label>Label</Label>
          <FieldInput
            value={data.label}
            onChange={handleLabelChange}
            placeholder="Node label"
          />
        </div>

        {data.nodeType === "trigger" && (
          <TriggerProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "agent" && (
          <AgentProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "tool" && (
          <ToolProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "skill" && (
          <SkillProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "condition" && (
          <ConditionProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "transform" && (
          <TransformProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}
        {data.nodeType === "output" && (
          <OutputProperties
            data={data}
            onChange={(p) => handleChange(p as Partial<WorkflowNodeData>)}
          />
        )}

        <div className="mt-6 pt-4 border-t border-border">
          <button
            type="button"
            onClick={() =>
              dispatch({ type: "REMOVE_NODES", ids: [node.id] })
            }
            className="w-full px-3 py-2 text-sm text-danger border border-danger/20 bg-danger-subtle rounded-md hover:bg-danger hover:text-white hover:border-danger transition-colors cursor-pointer"
          >
            Delete node
          </button>
        </div>
      </div>
    </aside>
  );
}
