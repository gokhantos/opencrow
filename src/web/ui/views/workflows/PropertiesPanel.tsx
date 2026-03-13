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
          <Label>Webhook URL</Label>
          <p className="text-xs text-muted leading-relaxed">
            Send a <code className="font-mono text-accent bg-bg-2 px-1 rounded">POST</code> request to:
          </p>
          <div className="mt-1.5 px-2 py-1.5 bg-bg border border-border-2 rounded-md text-xs font-mono text-faint break-all">
            /api/webhooks/&#123;workflowId&#125;
          </div>
          <p className="text-[11px] text-faint mt-1.5">
            The workflow must be enabled. The request body is passed as trigger input.
          </p>
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

interface SchemaProperty {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
}

function SchemaField({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: SchemaProperty;
  value: unknown;
  required: boolean;
  onChange: (v: unknown) => void;
}) {
  const label = name.replace(/_/g, " ");

  if (schema.enum && schema.enum.length > 0) {
    const options = schema.enum.map((v) => ({ value: String(v), label: String(v) }));
    return (
      <div className="mb-3">
        <Label>{label}{required ? " *" : ""}</Label>
        <FieldSelect
          value={String(value ?? "")}
          onChange={(v) => onChange(v)}
          options={options}
          placeholder={`Select ${label}...`}
        />
        {schema.description && (
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{schema.description}</p>
        )}
      </div>
    );
  }

  if (schema.type === "boolean") {
    return (
      <div className="mb-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded border-border-2 bg-bg accent-accent cursor-pointer"
          />
          <span className="text-xs font-semibold text-muted uppercase tracking-wider">
            {label}{required ? " *" : ""}
          </span>
        </label>
        {schema.description && (
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{schema.description}</p>
        )}
      </div>
    );
  }

  const isNumeric = schema.type === "number" || schema.type === "integer";

  return (
    <div className="mb-3">
      <Label>{label}{required ? " *" : ""}</Label>
      <FieldInput
        value={value !== undefined && value !== null ? String(value) : ""}
        onChange={(v) => {
          if (isNumeric && v !== "") {
            const num = Number(v);
            onChange(Number.isNaN(num) ? v : num);
          } else {
            onChange(v === "" ? undefined : v);
          }
        }}
        placeholder={schema.description ?? `Enter ${label}...`}
        type={isNumeric ? "number" : "text"}
      />
      {schema.description && (
        <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{schema.description}</p>
      )}
    </div>
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
  const [showRawJson, setShowRawJson] = useState(false);

  useEffect(() => {
    apiFetch<{ data: ToolOption[]; success: boolean }>("/api/tools")
      .then((res) => setTools(res.data))
      .catch(() => setTools([]));
  }, []);

  // Migrate legacy string inputMapping to Record
  useEffect(() => {
    if (typeof data.inputMapping === "string") {
      try {
        const parsed = JSON.parse(data.inputMapping) as Record<string, unknown>;
        onChange({ inputMapping: parsed });
      } catch {
        onChange({ inputMapping: {} });
      }
    }
  }, []);

  const toolOptions = tools.map((t) => ({ value: t.name, label: t.name }));
  const selectedTool = tools.find((t) => t.name === data.toolName);
  const inputMapping = (typeof data.inputMapping === "object" && data.inputMapping !== null)
    ? data.inputMapping
    : {};

  // Extract schema properties
  const schemaProps = (selectedTool?.inputSchema as Record<string, unknown>)?.properties as
    | Record<string, SchemaProperty>
    | undefined;
  const requiredFields = new Set(
    (selectedTool?.inputSchema as Record<string, unknown>)?.required as string[] ?? [],
  );
  const paramEntries = schemaProps ? Object.entries(schemaProps) : [];

  const handleToolChange = (toolName: string) => {
    onChange({ toolName, inputMapping: {} });
  };

  const handleParamChange = (paramName: string, value: unknown) => {
    const updated = { ...inputMapping };
    if (value === undefined || value === "") {
      delete (updated as Record<string, unknown>)[paramName];
    } else {
      (updated as Record<string, unknown>)[paramName] = value;
    }
    onChange({ inputMapping: updated });
  };

  const handleRawJsonChange = (jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      onChange({ inputMapping: parsed });
    } catch {
      // Don't update until valid JSON
    }
  };

  return (
    <>
      <div className="mb-4">
        <Label>Tool</Label>
        {toolOptions.length > 0 ? (
          <FieldSelect
            value={data.toolName}
            onChange={handleToolChange}
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

      {selectedTool?.description && (
        <div className="mb-4 px-2.5 py-2 bg-bg-2 rounded-md border border-border">
          <p className="text-[11px] text-muted leading-relaxed">{selectedTool.description}</p>
        </div>
      )}

      {paramEntries.length > 0 && !showRawJson && (
        <div className="mb-4">
          <Label>Parameters</Label>
          <div className="mt-1">
            {paramEntries.map(([name, schema]) => (
              <SchemaField
                key={name}
                name={name}
                schema={schema}
                value={(inputMapping as Record<string, unknown>)[name]}
                required={requiredFields.has(name)}
                onChange={(v) => handleParamChange(name, v)}
              />
            ))}
          </div>
          <p className="text-[11px] text-faint mt-1">
            Use <code className="font-mono text-accent bg-bg-2 px-0.5 rounded">{"{{nodeId.output}}"}</code> to reference other nodes.
          </p>
        </div>
      )}

      {(showRawJson || paramEntries.length === 0) && data.toolName && (
        <div className="mb-4">
          <Label>Input (JSON)</Label>
          <FieldTextarea
            value={JSON.stringify(inputMapping, null, 2)}
            onChange={handleRawJsonChange}
            placeholder='{"query": "{{trigger.output}}"}'
            rows={4}
          />
        </div>
      )}

      {paramEntries.length > 0 && (
        <button
          type="button"
          onClick={() => setShowRawJson((v) => !v)}
          className="text-[11px] text-faint hover:text-muted transition-colors cursor-pointer mb-4"
        >
          {showRawJson ? "Switch to form" : "Edit as JSON"}
        </button>
      )}
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
