import fs from "node:fs/promises";
import path from "node:path";

const SKILLS_DIR = path.resolve(import.meta.dir, "..", "..", "skills");
const VALID_SKILL_ID = /^[a-z0-9][a-z0-9-]*$/;

export type Skill = {
  id: string;
  name: string;
  description: string;
  path: string;
};

export interface SkillInput {
  name: string;
  description: string;
  content: string;
}

export interface SkillDetail {
  id: string;
  name: string;
  description: string;
  content: string;
  body: string;
}

function isValidSkillId(id: string): boolean {
  return VALID_SKILL_ID.test(id);
}

function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) return { meta: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of content.slice(3, end).trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { meta, body: content.slice(end + 4).trim() };
}

function toSkillId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeFrontmatter(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function buildSkillFile(input: SkillInput): string {
  return [
    "---",
    `name: ${sanitizeFrontmatter(input.name)}`,
    `description: ${sanitizeFrontmatter(input.description)}`,
    "---",
    "",
    input.content,
  ].join("\n");
}

export async function loadSkills(): Promise<Skill[]> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
      try {
        const content = await fs.readFile(skillPath, "utf8");
        const { meta } = parseFrontmatter(content);
        skills.push({
          id: entry.name,
          name: meta.name ?? entry.name,
          description: meta.description ?? "",
          path: skillPath,
        });
      } catch {
        // skip invalid
      }
    }
    return skills;
  } catch {
    return [];
  }
}

export async function readSkillContent(id: string): Promise<string | null> {
  if (!isValidSkillId(id)) return null;
  const skillPath = path.join(SKILLS_DIR, id, "SKILL.md");
  try {
    return await fs.readFile(skillPath, "utf8");
  } catch {
    return null;
  }
}

export async function readSkillDetail(id: string): Promise<SkillDetail | null> {
  if (!isValidSkillId(id)) return null;
  const raw = await readSkillContent(id);
  if (!raw) return null;
  const { meta, body } = parseFrontmatter(raw);
  return {
    id,
    name: meta.name ?? id,
    description: meta.description ?? "",
    content: raw,
    body,
  };
}

export async function createSkill(
  input: SkillInput,
): Promise<{ id: string; error?: string }> {
  const id = toSkillId(input.name);
  if (!id) return { id: "", error: "Invalid skill name" };

  const skillDir = path.join(SKILLS_DIR, id);
  try {
    await fs.access(skillDir);
    return { id: "", error: `Skill "${id}" already exists` };
  } catch {
    // directory doesn't exist, good
  }

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), buildSkillFile(input));
  return { id };
}

export async function updateSkill(
  id: string,
  input: SkillInput,
): Promise<{ error?: string }> {
  if (!isValidSkillId(id)) return { error: "Invalid skill id" };
  const skillPath = path.join(SKILLS_DIR, id, "SKILL.md");
  try {
    await fs.access(skillPath);
  } catch {
    return { error: "Skill not found" };
  }
  await fs.writeFile(skillPath, buildSkillFile(input));
  return {};
}

export async function deleteSkill(
  id: string,
): Promise<{ error?: string }> {
  if (!isValidSkillId(id)) return { error: "Invalid skill id" };
  const skillDir = path.join(SKILLS_DIR, id);
  try {
    await fs.access(skillDir);
  } catch {
    return { error: "Skill not found" };
  }
  await fs.rm(skillDir, { recursive: true });
  return {};
}
