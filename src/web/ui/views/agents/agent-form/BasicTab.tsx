import { cn } from "../../../lib/cn";
import { Input, FormField } from "../../../components";
import type { UseAgentFormReturn } from "./useAgentForm";

/** Basic tab: template picker (create mode) + agent identity fields. */
export function BasicTab({ form }: { form: UseAgentFormReturn }) {
  const { mode, templates, selectedTemplate, applyTemplate } = form;
  const {
    register,
    formState: { errors },
  } = form.form;

  return (
    <>
      {/* Template Picker (create mode only) */}
      {mode === "create" && templates.length > 0 && (
        <fieldset className="border-none p-0 m-0">
          <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full">
            Start from Template
          </legend>
          <div className="flex gap-2.5 overflow-x-auto pb-1">
            {templates.map((tpl) => (
              <button
                key={tpl.templateId}
                type="button"
                className={cn(
                  "flex flex-col gap-1 px-4 py-3 rounded-lg border text-left cursor-pointer transition-colors min-w-[130px] shrink-0",
                  selectedTemplate === tpl.templateId
                    ? "bg-accent-subtle border-accent"
                    : "bg-bg-2 border-border hover:border-border-2 hover:bg-bg-3",
                )}
                onClick={() => applyTemplate(tpl)}
              >
                <span
                  className={cn(
                    "text-sm font-semibold",
                    selectedTemplate === tpl.templateId
                      ? "text-accent"
                      : "text-strong",
                  )}
                >
                  {tpl.name}
                </span>
                <span className="text-xs text-muted leading-snug line-clamp-2">
                  {tpl.description}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* Section: Identity */}
      <fieldset className="border-none p-0 m-0">
        <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
          Identity
        </legend>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {mode === "create" && (
            <FormField error={errors.id} className="mb-5">
              <Input
                label="ID (kebab-case)"
                type="text"
                placeholder="my-agent"
                pattern="^[a-z0-9][a-z0-9-]*$"
                required
                {...register("id", {
                  onChange: (e) => {
                    e.target.value = e.target.value.toLowerCase();
                  },
                })}
              />
            </FormField>
          )}
          <FormField error={errors.name} className="mb-5">
            <Input
              label="Name"
              type="text"
              placeholder="My Agent"
              required
              {...register("name")}
            />
          </FormField>
          <div className="mb-5 col-span-full">
            <Input
              label="Description"
              type="text"
              placeholder="Short description of this agent's role"
              {...register("description")}
            />
          </div>
        </div>
      </fieldset>
    </>
  );
}
