import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, createSkillApi, updateSkillApi, deleteSkillApi } from "../../api";
import {
  LoadingState,
  EmptyState,
  PageHeader,
  SearchBar,
  Button,
} from "../../components";
import { useToast } from "../../components/Toast";
import { Plus, Upload, Sparkles } from "lucide-react";
import { SkillCard } from "./SkillCard";
import { SkillFormModal } from "./SkillFormModal";
import { SkillDetailModal } from "./SkillDetailModal";
import { AiSkillGenerator } from "./AiSkillGenerator";
import type {
  SkillInfo,
  SkillDetail,
  SkillsResponse,
  SkillFormData,
} from "./types";

export default function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editId, setEditId] = useState<string | undefined>(undefined);
  const [editData, setEditData] = useState<SkillFormData | undefined>(
    undefined,
  );
  const [aiGeneratorOpen, setAiGeneratorOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const loadSkills = useCallback(async () => {
    try {
      const res = await apiFetch<SkillsResponse>("/api/skills");
      setSkills(res.data);
      setError("");
    } catch {
      setError("Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  function openCreate() {
    setFormMode("create");
    setEditId(undefined);
    setEditData(undefined);
    setFormOpen(true);
  }

  function openEdit(detail: SkillDetail) {
    setFormMode("edit");
    setEditId(detail.id);
    setEditData({
      name: detail.name,
      description: detail.description,
      content: detail.body ?? "",
    });
    setSelectedSkill(null);
    setFormOpen(true);
  }

  function handleAiGenerated(data: SkillFormData) {
    setFormMode("create");
    setEditId(undefined);
    setEditData(data);
    setFormOpen(true);
  }

  async function handleSubmit(data: SkillFormData) {
    try {
      if (formMode === "create") {
        const res = await createSkillApi(data);
        if (!res.success) {
          toast.error(res.error ?? "Failed to create skill");
          return;
        }
        toast.success(`Skill "${data.name}" created`);
      } else if (editId) {
        const res = await updateSkillApi(editId, data);
        if (!res.success) {
          toast.error(res.error ?? "Failed to update skill");
          return;
        }
        toast.success(`Skill "${data.name}" updated`);
      }
      setFormOpen(false);
      await loadSkills();
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? (err as { message: string }).message
          : "Operation failed";
      toast.error(msg);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await deleteSkillApi(id);
      if (!res.success) {
        toast.error(res.error ?? "Failed to delete skill");
        return;
      }
      toast.success("Skill deleted");
      setSelectedSkill(null);
      await loadSkills();
    } catch {
      toast.error("Failed to delete skill");
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const nameFromFile = file.name.replace(/\.(md|txt)$/, "");
    setFormMode("create");
    setEditId(undefined);
    setEditData({
      name: nameFromFile,
      description: "",
      content: text,
    });
    setFormOpen(true);
    e.target.value = "";
  }

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  });

  if (loading) return <LoadingState />;

  return (
    <div className="max-w-[1400px]">
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-start justify-between gap-4 mb-1">
        <PageHeader
          title="Skills"
          subtitle="Create and manage skill definitions for your agents"
          count={skills.length}
        />
        <div className="flex gap-2 shrink-0 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            Load File
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAiGeneratorOpen(true)}
          >
            <Sparkles size={14} />
            AI Generate
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} />
            Create Skill
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-5">
          {error}
        </div>
      )}

      <div className="mb-6 max-w-md">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Search skills..."
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          description={
            skills.length === 0
              ? "No skills yet. Create your first skill to get started."
              : "No skills match your search."
          }
        />
      ) : (
        <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-4">
          {filtered.map((skill, i) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              index={i}
              onClick={() => setSelectedSkill(skill)}
            />
          ))}
        </div>
      )}

      <SkillDetailModal
        skill={selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onEdit={openEdit}
        onDelete={handleDelete}
      />

      <SkillFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
        initial={editData}
        mode={formMode}
      />

      <AiSkillGenerator
        open={aiGeneratorOpen}
        onClose={() => setAiGeneratorOpen(false)}
        onGenerated={handleAiGenerated}
      />
    </div>
  );
}
