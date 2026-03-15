import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";
import type { Ontology, EntityType, RelationshipType } from "./ontology-generator";
interface MemoryItem {
  readonly content: string;
  readonly source?: string;
  readonly sourceDescription?: string;
}

const log = createLogger("sige:entity-extractor");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedEntity {
  readonly name: string;
  readonly entityType: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface ExtractedRelationship {
  readonly sourceEntity: string;
  readonly targetEntity: string;
  readonly relationType: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, string>>;
}

export interface ExtractionResult {
  readonly entities: readonly ExtractedEntity[];
  readonly relationships: readonly ExtractedRelationship[];
  readonly summary: string;
}

// ─── Raw LLM Response Shapes ──────────────────────────────────────────────────

interface RawEntity {
  name?: unknown;
  entityType?: unknown;
  attributes?: unknown;
  description?: unknown;
}

interface RawRelationship {
  sourceEntity?: unknown;
  targetEntity?: unknown;
  relationType?: unknown;
  description?: unknown;
  properties?: unknown;
}

interface RawExtractionResult {
  entities?: unknown;
  relationships?: unknown;
  summary?: unknown;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an entity extraction specialist. Extract entities and relationships from text according to a given ontology. Return only valid JSON — no markdown, no explanation.";

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function formatEntityTypes(entityTypes: readonly EntityType[]): string {
  return entityTypes
    .map((et) => `  - ${et.name} (${et.category}): ${et.description}`)
    .join("\n");
}

function formatRelationshipTypes(relationshipTypes: readonly RelationshipType[]): string {
  return relationshipTypes
    .map(
      (rt) =>
        `  - ${rt.name}: ${rt.description} (${rt.sourceEntityTypes.join(", ")} → ${rt.targetEntityTypes.join(", ")})`,
    )
    .join("\n");
}

function buildExtractionPrompt(text: string, ontology: Ontology): string {
  return `You are an entity extraction specialist. Given a text and an ontology, extract all entities and relationships.

Ontology entity types:
${formatEntityTypes(ontology.entityTypes)}

Ontology relationship types:
${formatRelationshipTypes(ontology.relationshipTypes)}

Extract:
1. All entities matching the defined types, with their attributes
2. All relationships between extracted entities matching the defined relationship types

Return ONLY valid JSON:
{
  "entities": [{ "name": "...", "entityType": "...", "attributes": {...}, "description": "..." }],
  "relationships": [{ "sourceEntity": "...", "targetEntity": "...", "relationType": "...", "description": "...", "properties": {...} }],
  "summary": "One paragraph summary of the key strategic dynamics in this text"
}

<text>
${text}
</text>

Return the JSON extraction:`;
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(text: string): RawExtractionResult {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as RawExtractionResult;
  } catch {
    // fall through
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as RawExtractionResult;
    } catch {
      // fall through
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawExtractionResult;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from LLM response. Preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

function toStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = typeof v === "string" ? v : String(v);
  }
  return result;
}

function validateEntity(raw: unknown, index: number): ExtractedEntity {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`entities[${index}] must be an object`);
  }
  const obj = raw as RawEntity;

  if (typeof obj.name !== "string" || !obj.name) {
    throw new Error(`entities[${index}].name must be a non-empty string`);
  }
  if (typeof obj.entityType !== "string" || !obj.entityType) {
    throw new Error(`entities[${index}].entityType must be a non-empty string`);
  }

  return {
    name: obj.name,
    entityType: obj.entityType,
    attributes: toStringRecord(obj.attributes),
    description: typeof obj.description === "string" ? obj.description : "",
  };
}

function validateRelationship(raw: unknown, index: number): ExtractedRelationship {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`relationships[${index}] must be an object`);
  }
  const obj = raw as RawRelationship;

  if (typeof obj.sourceEntity !== "string" || !obj.sourceEntity) {
    throw new Error(`relationships[${index}].sourceEntity must be a non-empty string`);
  }
  if (typeof obj.targetEntity !== "string" || !obj.targetEntity) {
    throw new Error(`relationships[${index}].targetEntity must be a non-empty string`);
  }
  if (typeof obj.relationType !== "string" || !obj.relationType) {
    throw new Error(`relationships[${index}].relationType must be a non-empty string`);
  }

  return {
    sourceEntity: obj.sourceEntity,
    targetEntity: obj.targetEntity,
    relationType: obj.relationType,
    description: typeof obj.description === "string" ? obj.description : "",
    properties: toStringRecord(obj.properties),
  };
}

function validateExtractionResult(raw: RawExtractionResult): ExtractionResult {
  const entities = Array.isArray(raw.entities)
    ? (raw.entities as unknown[]).map(validateEntity)
    : [];

  const relationships = Array.isArray(raw.relationships)
    ? (raw.relationships as unknown[]).map(validateRelationship)
    : [];

  return {
    entities,
    relationships,
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };
}

// ─── Text Chunking ────────────────────────────────────────────────────────────

const SENTENCE_BOUNDARIES = /(?<=[\.\!\?])\s+|(?<=\n\n)/;

function chunkText(text: string, chunkSize: number, overlap: number): readonly string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  // Split at sentence boundaries to preserve semantic units
  const sentences = text.split(SENTENCE_BOUNDARIES).filter((s) => s.trim().length > 0);

  const chunks: string[] = [];
  let currentChunk = "";
  let overlapBuffer = "";

  for (const sentence of sentences) {
    const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;

    if (candidate.length > chunkSize && currentChunk) {
      chunks.push(currentChunk.trim());
      // Carry forward the overlap: take the tail of the current chunk
      overlapBuffer = currentChunk.slice(Math.max(0, currentChunk.length - overlap));
      currentChunk = overlapBuffer ? `${overlapBuffer} ${sentence}` : sentence;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// ─── Concurrency Limiter ──────────────────────────────────────────────────────

function createSemaphore(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  }

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  function release(): void {
    active--;
    next();
  }

  return { acquire, release };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function mergeEntities(all: readonly ExtractedEntity[]): readonly ExtractedEntity[] {
  const byName = new Map<string, ExtractedEntity>();

  for (const entity of all) {
    const key = entity.name.toLowerCase();
    const existing = byName.get(key);

    if (!existing) {
      byName.set(key, entity);
    } else {
      // Merge attributes — existing takes precedence for conflicts
      byName.set(key, {
        ...existing,
        attributes: { ...entity.attributes, ...existing.attributes },
        description: existing.description || entity.description,
      });
    }
  }

  return Array.from(byName.values());
}

function mergeRelationships(
  all: readonly ExtractedRelationship[],
): readonly ExtractedRelationship[] {
  const seen = new Set<string>();
  const result: ExtractedRelationship[] = [];

  for (const rel of all) {
    const key = `${rel.sourceEntity.toLowerCase()}|${rel.targetEntity.toLowerCase()}|${rel.relationType.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(rel);
    }
  }

  return result;
}

function mergeSummaries(summaries: readonly string[]): string {
  const valid = summaries.filter((s) => s.trim().length > 0);
  if (valid.length === 0) return "";
  if (valid.length === 1) return valid[0]!;
  // Combine into a single multi-sentence summary
  return valid.join(" ");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractEntities(
  text: string,
  ontology: Ontology,
  options: { readonly model: string; readonly provider?: "openrouter" | "agent-sdk" | "alibaba" },
): Promise<ExtractionResult> {
  const userContent = buildExtractionPrompt(text, ontology);

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: userContent,
      timestamp: Date.now(),
    },
  ];

  log.debug("Extracting entities from chunk", {
    model: options.model,
    textLength: text.length,
    entityTypeCount: ontology.entityTypes.length,
    relationshipTypeCount: ontology.relationshipTypes.length,
  });

  let responseText: string;

  try {
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      provider: options.provider ?? "alibaba",
    });
    responseText = response.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LLM call failed during entity extraction", { err });
    throw new Error(`Entity extraction LLM call failed: ${msg}`);
  }

  if (!responseText.trim()) {
    throw new Error("Entity extraction returned an empty response from the LLM");
  }

  let raw: RawExtractionResult;
  try {
    raw = extractJson(responseText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to parse extraction JSON", {
      err,
      responsePreview: responseText.slice(0, 300),
    });
    throw new Error(`Failed to parse extraction JSON from LLM response: ${msg}`);
  }

  const result = validateExtractionResult(raw);

  log.debug("Entities extracted from chunk", {
    entityCount: result.entities.length,
    relationshipCount: result.relationships.length,
  });

  return result;
}

export async function processDocument(
  document: string,
  ontology: Ontology,
  options: {
    readonly model: string;
    readonly provider?: "openrouter" | "agent-sdk" | "alibaba";
    readonly chunkSize?: number;
    readonly chunkOverlap?: number;
    readonly maxConcurrent?: number;
  },
): Promise<ExtractionResult> {
  const chunkSize = options.chunkSize ?? 4_000;
  const chunkOverlap = options.chunkOverlap ?? 200;
  const maxConcurrent = options.maxConcurrent ?? 5;

  const chunks = chunkText(document, chunkSize, chunkOverlap);

  log.info("Processing document", {
    model: options.model,
    documentLength: document.length,
    chunkCount: chunks.length,
    chunkSize,
    chunkOverlap,
    maxConcurrent,
  });

  const semaphore = createSemaphore(maxConcurrent);
  const chunkOptions = { model: options.model };

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, i) => {
      await semaphore.acquire();
      try {
        return await extractEntities(chunk, ontology, chunkOptions);
      } catch (err) {
        log.warn("Chunk extraction failed, skipping", {
          chunkIndex: i,
          chunkLength: chunk.length,
          err,
        });
        return null;
      } finally {
        semaphore.release();
      }
    }),
  );

  const successful = chunkResults.filter(
    (r): r is ExtractionResult => r !== null,
  );

  if (successful.length === 0) {
    log.warn("All chunks failed extraction", {
      documentLength: document.length,
      chunkCount: chunks.length,
    });
    return { entities: [], relationships: [], summary: "" };
  }

  const allEntities = successful.flatMap((r) => [...r.entities]);
  const allRelationships = successful.flatMap((r) => [...r.relationships]);
  const allSummaries = successful.map((r) => r.summary);

  const merged: ExtractionResult = {
    entities: mergeEntities(allEntities),
    relationships: mergeRelationships(allRelationships),
    summary: mergeSummaries(allSummaries),
  };

  log.info("Document processing complete", {
    chunksProcessed: successful.length,
    chunksTotal: chunks.length,
    entityCount: merged.entities.length,
    relationshipCount: merged.relationships.length,
  });

  return merged;
}

export function toMemoryItems(
  result: ExtractionResult,
  source: string,
): readonly MemoryItem[] {
  const episodes: MemoryItem[] = [];

  for (const entity of result.entities) {
    const attrParts = Object.entries(entity.attributes)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    const content = attrParts
      ? `${entity.name} is a ${entity.entityType}. ${entity.description}. Attributes: ${attrParts}`
      : `${entity.name} is a ${entity.entityType}. ${entity.description}`;

    episodes.push({ content: content.trim(), source, sourceDescription: "entity" });
  }

  for (const rel of result.relationships) {
    const content = `${rel.sourceEntity} ${rel.relationType} ${rel.targetEntity}. ${rel.description}`;
    episodes.push({ content: content.trim(), source, sourceDescription: "relationship" });
  }

  if (result.summary.trim()) {
    episodes.push({
      content: result.summary.trim(),
      source,
      sourceDescription: "summary",
    });
  }

  return episodes;
}
