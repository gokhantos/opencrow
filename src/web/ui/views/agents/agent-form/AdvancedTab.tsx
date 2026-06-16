import { Input } from "../../../components";
import { MCP_SERVERS } from "./constants";
import type { UseAgentFormReturn } from "./useAgentForm";

/** Advanced tab: sub-agents, MCP servers, hooks, Telegram. */
export function AdvancedTab({ form }: { form: UseAgentFormReturn }) {
  const { register } = form.form;

  return (
    <div className="flex flex-col gap-6">
      {/* Sub-Agents */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          Sub-Agents
        </h4>
        <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
          <div className="mb-5">
            <Input
              label="Allowed Agents"
              type="text"
              placeholder="* for all, or specific IDs"
              {...register("allowAgents")}
            />
          </div>
          <div className="mb-5">
            <Input
              label="Max Children"
              type="number"
              min={1}
              max={20}
              {...register("maxChildren", { valueAsNumber: true })}
            />
          </div>
        </div>
      </div>

      {/* MCP Servers */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          MCP Servers
        </h4>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {MCP_SERVERS.map(({ name, label }) => (
            <div key={name} className="flex items-center mb-5">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-accent cursor-pointer"
                  {...register(name)}
                />
                <span className="select-none">{label}</span>
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Hooks */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          Hooks
        </h4>
        <p className="text-sm text-faint m-0 mb-2.5 leading-[1.4]">
          Hooks run during agent execution for auditing and notifications. All
          hooks are on by default.
        </p>
        <div className="ml-1">
          <div className="flex items-center mb-5">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
              <input
                type="checkbox"
                className="w-4 h-4 accent-accent cursor-pointer"
                {...register("hookAuditLog")}
              />
              <span className="select-none">Audit Log (tool calls to DB)</span>
            </label>
          </div>
          <div className="flex items-center mb-5">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
              <input
                type="checkbox"
                className="w-4 h-4 accent-accent cursor-pointer"
                {...register("hookNotifications")}
              />
              <span className="select-none">Notification Forwarding</span>
            </label>
          </div>
        </div>
      </div>

      {/* Telegram */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          Telegram
        </h4>
        <div className="mb-5">
          <Input
            label="Bot Token"
            type="password"
            placeholder="Leave empty to disable dedicated bot"
            autoComplete="off"
            {...register("telegramBotToken")}
          />
        </div>
      </div>
    </div>
  );
}
