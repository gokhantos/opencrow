import { encodingForModel } from "js-tiktoken";

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP = 80;

interface ChunkOptions {
  readonly maxTokens?: number;
  readonly overlap?: number;
}

const encoder = encodingForModel("text-embedding-3-small");

function countTokens(text: string): number {
  return encoder.encode(text).length;
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter(Boolean);
}

export function chunkText(text: string, opts?: ChunkOptions): string[] {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = opts?.overlap ?? DEFAULT_OVERLAP;

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);

    if (currentTokens + sentenceTokens > maxTokens && current.length > 0) {
      chunks.push(current.join(" "));

      // Rebuild with overlap from the end
      const overlapSentences: string[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = countTokens(current[i]!);
        if (overlapTokens + t > overlap) break;
        overlapSentences.unshift(current[i]!);
        overlapTokens += t;
      }
      current = overlapSentences;
      currentTokens = overlapTokens;
    }

    current.push(sentence);
    currentTokens += sentenceTokens;
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

export function chunkConversation(
  messages: readonly { readonly role: string; readonly content: string }[],
  opts?: ChunkOptions,
): string[] {
  const formatted = messages.map((m) => `[${m.role}] ${m.content}`).join("\n");

  return chunkText(formatted, opts);
}
