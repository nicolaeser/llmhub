import { estimateTokens } from "@/lib/gateway/tokens";
import type { ChunkSettings, ChunkingStrategy, TextChunk } from "@/types/rag";

export const AUTO_CHUNK_TOKENS = 800;
export const AUTO_OVERLAP_TOKENS = 400;
const CHARS_PER_TOKEN = 4;
const BREAKS = ["\n\n", "\n", ". ", "! ", "? ", "; ", " "] as const;

export function chunkSettings(
  strategy: ChunkingStrategy | null | undefined,
  fallback: { maxTokens: number; overlapTokens: number } = {
    maxTokens: AUTO_CHUNK_TOKENS,
    overlapTokens: AUTO_OVERLAP_TOKENS,
  },
): ChunkSettings {
  if (strategy?.type === "static") {
    return {
      type: "static",
      maxTokens: strategy.static.max_chunk_size_tokens,
      overlapTokens: strategy.static.chunk_overlap_tokens,
    };
  }
  if (strategy?.type === "auto") {
    return { type: "auto", maxTokens: AUTO_CHUNK_TOKENS, overlapTokens: AUTO_OVERLAP_TOKENS };
  }
  const custom =
    fallback.maxTokens !== AUTO_CHUNK_TOKENS || fallback.overlapTokens !== AUTO_OVERLAP_TOKENS;
  return { type: custom ? "static" : "auto", ...fallback };
}

export function chunkingJson(settings: Pick<ChunkSettings, "maxTokens" | "overlapTokens">) {
  return {
    type: "static" as const,
    static: {
      max_chunk_size_tokens: settings.maxTokens,
      chunk_overlap_tokens: settings.overlapTokens,
    },
  };
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function breakPoint(text: string, min: number, max: number): number {
  for (const mark of BREAKS) {
    const at = text.lastIndexOf(mark, max - mark.length);
    if (at >= min) return at + mark.length;
  }
  return max;
}

function wordStart(text: string, from: number, limit: number): number {
  for (let i = from; i < limit; i++) {
    if (/\s/.test(text[i - 1] ?? " ")) return i;
  }
  return from;
}

export function chunkText(source: string, settings: Pick<ChunkSettings, "maxTokens" | "overlapTokens">): TextChunk[] {
  const text = normalizeText(source);
  const maxChars = Math.max(1, settings.maxTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, Math.min(settings.overlapTokens, settings.maxTokens / 2) * CHARS_PER_TOKEN);
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) end = breakPoint(text, start + Math.floor(maxChars / 2), end);
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ text: piece, tokens: estimateTokens(piece), position: chunks.length });
    if (end >= text.length) break;
    const next = Math.max(end - overlapChars, start + 1);
    start = wordStart(text, next, end);
  }
  return chunks;
}
