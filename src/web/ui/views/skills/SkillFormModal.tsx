import React, { useState, useEffect, useRef } from "react";
import { Modal, Button, Input, FormField } from "../../components";
import { FileText, Sparkles, ChevronDown } from "lucide-react";
import { SKILL_TEMPLATES } from "./types";
import type { SkillFormData, SkillTemplate } from "./types";

interface SkillFormModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (data: SkillFormData) => Promise<void>;
  readonly initial?: SkillFormData;
  readonly mode: "create" | "edit";
}

export function SkillFormModal({
  open,
  onClose,
  onSubmit,
  initial,
  mode,
}: SkillFormModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showTemplates, setShowTemplates] = useState(false);
  const templateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
      setContent(initial?.content ?? "");
      setErrors({});
      setShowTemplates(false);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!showTemplates) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        templateRef.current &&
        !templateRef.current.contains(e.target as Node)
      ) {
        setShowTemplates(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTemplates]);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Name is required";
    if (!description.trim()) next.description = "Description is required";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        content: content.trim(),
      });
    } finally {
      setSaving(false);
    }
  }

  function applyTemplate(template: SkillTemplate) {
    if (mode === "create" && !name.trim()) {
      setName(template.name);
    }
    if (mode === "create" && !description.trim()) {
      setDescription(template.description);
    }
    setContent(template.content);
    setShowTemplates(false);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "create" ? "Create Skill" : "Edit Skill"}
      width="680px"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <FormField
          label="Name"
          id="skill-name"
          error={errors.name ? { message: errors.name, type: "manual" } : undefined}
        >
          <Input
            id="skill-name"
            placeholder="e.g. Code Review, Data Analysis"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </FormField>

        <FormField
          label="Description"
          id="skill-desc"
          error={
            errors.description
              ? { message: errors.description, type: "manual" }
              : undefined
          }
        >
          <Input
            id="skill-desc"
            placeholder="Brief description of what this skill does"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label
              className="block text-sm font-semibold text-muted uppercase tracking-wide"
              htmlFor="skill-content"
            >
              Content
            </label>
            <div className="relative" ref={templateRef}>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent/10 rounded-md hover:bg-accent/20 transition-colors cursor-pointer border-none"
                onClick={() => setShowTemplates((v) => !v)}
              >
                <Sparkles size={12} />
                Templates
                <ChevronDown size={12} />
              </button>
              {showTemplates && (
                <div className="absolute right-0 top-full mt-1 w-64 bg-bg-1 border border-border-2 rounded-lg shadow-xl shadow-black/30 z-10 overflow-hidden">
                  {SKILL_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="w-full text-left px-4 py-3 hover:bg-bg-2 transition-colors cursor-pointer border-none bg-transparent border-b border-border last:border-b-0"
                      onClick={() => applyTemplate(t)}
                    >
                      <span className="block text-sm font-medium text-strong">
                        {t.name}
                      </span>
                      <span className="block text-xs text-muted mt-0.5">
                        {t.description}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <textarea
            id="skill-content"
            className="w-full px-4 py-3 bg-bg border border-border-2 rounded-lg text-foreground text-sm font-mono outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint resize-y leading-relaxed min-h-[240px]"
            placeholder="Write your skill content in markdown..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <p className="text-faint text-xs mt-1.5">
            Supports markdown. Define instructions, steps, examples, and
            guidelines for this skill.
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t border-border">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <FileText size={16} />
            {mode === "create" ? "Create Skill" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
