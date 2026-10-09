import { bm25, frequencyIn } from "@/lib/rag/lexical";
import { quantizedDot } from "@/lib/rag/vectors";
import type { IndexedFile, Ranker, RankingOptions } from "@/types/rag";

export const DEFAULT_EMBEDDING_WEIGHT = 0.7;
export const DEFAULT_TEXT_WEIGHT = 0.3;

export function rankingOptions(
  raw:
    | {
        ranker?: Ranker | null;
        score_threshold?: number | null;
        hybrid_search?: { embedding_weight: number; text_weight: number } | null;
      }
    | null
    | undefined,
): RankingOptions {
  return {
    ranker: raw?.ranker ?? "auto",
    scoreThreshold: raw?.score_threshold ?? 0,
    embeddingWeight: raw?.hybrid_search?.embedding_weight ?? DEFAULT_EMBEDDING_WEIGHT,
    textWeight: raw?.hybrid_search?.text_weight ?? DEFAULT_TEXT_WEIGHT,
  };
}

export function scoreFiles(
  files: IndexedFile[],
  query: Float32Array,
  terms: number[],
  ranking: RankingOptions,
): { file: IndexedFile; slot: number; score: number }[] {
  const lexical = ranking.ranker !== "none" && ranking.textWeight > 0 && terms.length > 0;
  const width = terms.length;
  const df = new Uint32Array(width);
  const frequencies: Uint16Array[] = [];
  let docs = 0;
  let totalLength = 0;
  for (const { index } of files) {
    const n = index.ids.length;
    docs += n;
    const tf = new Uint16Array(lexical ? n * width : 0);
    if (lexical) {
      for (let i = 0; i < n; i++) {
        totalLength += index.lengths[i]!;
        const from = index.termStarts[i]!;
        const to = index.termStarts[i + 1]!;
        for (let t = 0; t < width; t++) {
          const freq = frequencyIn(index.termHashes, index.termFreqs, from, to, terms[t]!);
          if (!freq) continue;
          tf[i * width + t] = freq;
          df[t]! += 1;
        }
      }
    }
    frequencies.push(tf);
  }
  const avgLength = docs ? totalLength / docs : 0;
  let maxText = 0;
  const textScores = files.map(({ index }, f) => {
    const n = index.ids.length;
    const scores = new Float32Array(lexical ? n : 0);
    if (!lexical) return scores;
    const tf = frequencies[f]!;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let t = 0; t < width; t++) {
        const freq = tf[i * width + t]!;
        if (freq) sum += bm25(freq, df[t]!, docs, index.lengths[i]!, avgLength);
      }
      scores[i] = sum;
      if (sum > maxText) maxText = sum;
    }
    return scores;
  });
  const useText = lexical && maxText > 0;
  const weight = ranking.embeddingWeight + (useText ? ranking.textWeight : 0);
  const out: { file: IndexedFile; slot: number; score: number }[] = [];
  files.forEach((file, f) => {
    const { index } = file;
    const comparable = index.dims === query.length;
    for (let i = 0; i < index.ids.length; i++) {
      const scale = index.scales[i]!;
      const cosine =
        comparable && scale ? Math.max(0, quantizedDot(query, index.vectors, i * index.dims, index.dims, scale)) : 0;
      const text = useText ? textScores[f]![i]! / maxText : 0;
      const score = useText && weight > 0 ? (ranking.embeddingWeight * cosine + ranking.textWeight * text) / weight : cosine;
      if (score > 0) out.push({ file, slot: i, score: Math.min(1, score) });
    }
  });
  return out;
}
