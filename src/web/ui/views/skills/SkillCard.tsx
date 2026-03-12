import React from "react";
import { GraduationCap } from "lucide-react";
import type { SkillInfo } from "./types";

interface SkillCardProps {
  readonly skill: SkillInfo;
  readonly index: number;
  readonly onClick: () => void;
}

export function SkillCard({ skill, index, onClick }: SkillCardProps) {
  return (
    <button
      type="button"
      className="group relative bg-bg-1 border rounded-lg overflow-hidden text-left cursor-pointer transition-all duration-200 hover:border-border-hover hover:bg-bg-1/80"
      style={{
        animation: `agCardIn 0.3s ease-out ${index * 20}ms both`,
      }}
      onClick={onClick}
    >
      <div className="px-5 py-4">
        <div className="flex items-center gap-2.5 mb-2">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <GraduationCap size={16} className="text-accent" />
          </div>
          <span className="font-semibold text-strong truncate">
            {skill.name}
          </span>
        </div>
        <p className="text-sm text-muted m-0 leading-relaxed line-clamp-2">
          {skill.description}
        </p>
      </div>
    </button>
  );
}
