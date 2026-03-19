import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";

const log = createLogger("sige:ontology-generator");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EntityType {
  readonly name: string;
  readonly description: string;
  readonly attributes: readonly string[];
  readonly category: string;
}

export interface RelationshipType {
  readonly name: string;
  readonly description: string;
  readonly sourceEntityTypes: readonly string[];
  readonly targetEntityTypes: readonly string[];
  readonly properties: readonly string[];
}

export interface Ontology {
  readonly domain: string;
  readonly entityTypes: readonly EntityType[];
  readonly relationshipTypes: readonly RelationshipType[];
  readonly categories: readonly string[];
}

export interface GenerateOntologyOptions {
  readonly model: string;
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba" | "anthropic";
  readonly maxEntityTypes?: number;
  readonly maxRelationshipTypes?: number;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an ontology engineer. Analyze domain text and produce a structured ontology for knowledge graph construction. Return only valid JSON — no markdown, no explanation.";

function buildUserPrompt(
  seedText: string,
  maxEntityTypes: number,
  maxRelationshipTypes: number,
): string {
  return `You are an ontology engineer. Analyze the following text and generate a domain-specific ontology for knowledge graph construction.

The ontology will be used for:
- Extracting entities and relationships from documents
- Building a knowledge graph for game-theoretic analysis
- Identifying actors, resources, constraints, and strategic relationships

Generate an ontology with:
1. Entity types — categories of things/actors in this domain (e.g., "Company", "Regulator", "Technology"). Maximum ${maxEntityTypes}.
2. Relationship types — how entities relate (e.g., "competes_with", "regulates", "depends_on"). Maximum ${maxRelationshipTypes}.
3. Categories — high-level groupings of entity types (typically 3-7).

Focus on:
- Actors who can take strategic actions
- Resources and assets at stake
- Constraints and rules governing behavior
- Causal and competitive relationships
- Information asymmetries

Each entity type must include:
- name: PascalCase label (e.g., "MarketRegulator")
- description: one sentence
- attributes: 2-5 relevant properties (e.g., ["jurisdiction", "enforcement_power"])
- category: which high-level category it belongs to

Each relationship type must include:
- name: snake_case verb phrase (e.g., "competes_with")
- description: one sentence
- sourceEntityTypes: list of entity type names that can be the source
- targetEntityTypes: list of entity type names that can be the target
- properties: 0-3 relevant edge properties (e.g., ["since_year", "intensity"])

Return ONLY valid JSON in this exact format (no markdown code blocks):
{
  "domain": "detected domain name",
  "categories": ["Category1", "Category2"],
  "entityTypes": [
    {
      "name": "EntityName",
      "description": "...",
      "attributes": ["attr1", "attr2"],
      "category": "Category1"
    }
  ],
  "relationshipTypes": [
    {
      "name": "relationship_name",
      "description": "...",
      "sourceEntityTypes": ["EntityName"],
      "targetEntityTypes": ["EntityName"],
      "properties": ["prop1"]
    }
  ]
}

<seed_text>
${seedText}
</seed_text>

Return the JSON ontology:`;
}

// ─── JSON Parsing ─────────────────────────────────────────────────────────────

interface RawOntology {
  domain?: unknown;
  entityTypes?: unknown;
  relationshipTypes?: unknown;
  categories?: unknown;
}

function extractJson(text: string): RawOntology {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed) as RawOntology;
  } catch {
    // fall through
  }

  // Try extracting from a ```json ... ``` code block
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as RawOntology;
    } catch {
      // fall through
    }
  }

  // Try finding a bare {...} object
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawOntology;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from LLM response. Response preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

function toStringArray(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Ontology field "${fieldName}" must be an array, got ${typeof value}`);
  }
  return value.map((item, i) => {
    if (typeof item !== "string") {
      throw new Error(`Ontology field "${fieldName}[${i}]" must be a string, got ${typeof item}`);
    }
    return item;
  });
}

function validateEntityType(raw: unknown, index: number): EntityType {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`entityTypes[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name) {
    throw new Error(`entityTypes[${index}].name must be a non-empty string`);
  }
  if (typeof obj.description !== "string") {
    throw new Error(`entityTypes[${index}].description must be a string`);
  }
  if (typeof obj.category !== "string") {
    throw new Error(`entityTypes[${index}].category must be a string`);
  }

  return {
    name: obj.name,
    description: obj.description,
    attributes: toStringArray(obj.attributes ?? [], `entityTypes[${index}].attributes`),
    category: obj.category,
  };
}

function validateRelationshipType(raw: unknown, index: number): RelationshipType {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`relationshipTypes[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name) {
    throw new Error(`relationshipTypes[${index}].name must be a non-empty string`);
  }
  if (typeof obj.description !== "string") {
    throw new Error(`relationshipTypes[${index}].description must be a string`);
  }

  return {
    name: obj.name,
    description: obj.description,
    sourceEntityTypes: toStringArray(
      obj.sourceEntityTypes ?? [],
      `relationshipTypes[${index}].sourceEntityTypes`,
    ),
    targetEntityTypes: toStringArray(
      obj.targetEntityTypes ?? [],
      `relationshipTypes[${index}].targetEntityTypes`,
    ),
    properties: toStringArray(obj.properties ?? [], `relationshipTypes[${index}].properties`),
  };
}

function validateOntology(raw: RawOntology): Ontology {
  const domain = typeof raw.domain === "string" && raw.domain
    ? raw.domain
    : "general";

  const entityTypes = Array.isArray(raw.entityTypes) ? raw.entityTypes : [];
  const relationshipTypes = Array.isArray(raw.relationshipTypes) ? raw.relationshipTypes : [];

  const categories = toStringArray(raw.categories ?? [], "categories");
  const validatedEntityTypes = (entityTypes as unknown[]).map(validateEntityType);
  const validatedRelationshipTypes = (relationshipTypes as unknown[]).map(validateRelationshipType);

  return {
    domain,
    categories,
    entityTypes: validatedEntityTypes,
    relationshipTypes: validatedRelationshipTypes,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateOntology(
  seedText: string,
  options: GenerateOntologyOptions,
): Promise<Ontology> {
  const maxEntityTypes = options.maxEntityTypes ?? 15;
  const maxRelationshipTypes = options.maxRelationshipTypes ?? 20;

  const userContent = buildUserPrompt(seedText, maxEntityTypes, maxRelationshipTypes);

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: userContent,
      timestamp: Date.now(),
    },
  ];

  log.info("Generating ontology", {
    model: options.model,
    seedTextLength: seedText.length,
    maxEntityTypes,
    maxRelationshipTypes,
  });

  let responseText: string;

  try {
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      provider: options.provider ?? "agent-sdk",
      rawSystemPrompt: true,
    });
    responseText = response.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LLM call failed during ontology generation", { err });
    throw new Error(`Ontology generation LLM call failed: ${msg}`);
  }

  if (!responseText.trim()) {
    throw new Error("Ontology generation returned an empty response from the LLM");
  }

  let raw: RawOntology;
  try {
    raw = extractJson(responseText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to parse ontology JSON", { err, responsePreview: responseText.slice(0, 300) });
    throw new Error(`Failed to parse ontology JSON from LLM response: ${msg}`);
  }

  let ontology: Ontology;
  try {
    ontology = validateOntology(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Ontology validation failed", { err });
    throw new Error(`Ontology structure validation failed: ${msg}`);
  }

  log.info("Ontology generated", {
    domain: ontology.domain,
    entityTypeCount: ontology.entityTypes.length,
    relationshipTypeCount: ontology.relationshipTypes.length,
    categoryCount: ontology.categories.length,
  });

  return ontology;
}
