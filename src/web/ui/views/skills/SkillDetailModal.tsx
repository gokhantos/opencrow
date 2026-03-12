import React, { useState, useEffect } from "react";
import { Modal, Button } from "../../components";
import { fetchSkillDetail } from "../../api";
import { GraduationCap, Pencil, Trash2 } from "lucide-react";
import type { SkillDetail, SkillInfo } from "./types";

interface SkillDetailModalProps {
  readonly skill: SkillInfo | null;
  readonly onClose: () => void;
  readonly onEdit: (detail: SkillDetail) => void;
  readonly onDelete: (id: string) => void;
}

export function SkillDetailModal({
  skill,
  onClose,
  onEdit,
  onDelete,
}: SkillDetailModalProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!skill) {
      setDetail(null);
      setConfirmDelete(false);
      return;
    }
    setLoading(true);
    setConfirmDelete(false);
    fetchSkillDetail(skill.id)
      .then((res) => setDetail(res.data))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [skill]);

  if (!skill) return null;

  return (
    <Modal open={!!skill} onClose={onClose} width="720px">
      <div className="flex items-start justify-between gap-4 -mt-1 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <GraduationCap size={20} className="text-accent" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-strong m-0">
              {skill.name}
            </h3>
            <p className="text-sm text-muted m-0 mt-0.5">
              {skill.description}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : detail?.body ? (
        <div className="bg-bg rounded-lg border border-border-2 p-5 text-sm text-foreground font-mono whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto">
          {detail.body}
        </div>
      ) : (
        <div className="bg-bg-2 rounded-lg p-6 text-center text-muted">
          <p className="text-sm">No content defined for this skill.</p>
        </div>
      )}

      <div className="flex items-center justify-between mt-5 pt-4 border-t border-border">
        <div>
          {confirmDelete ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-sm text-muted">Delete this skill?</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(skill.id);
                }}
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          {detail && (
            <Button
              size="sm"
              onClick={() => onEdit(detail)}
            >
              <Pencil size={14} />
              Edit
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
