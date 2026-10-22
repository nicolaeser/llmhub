import { tokenHead, tokenLogits } from "./heads.mjs";
import { tokenOffsets, trimSpan } from "./offsets.mjs";
import { createDecoder } from "./viterbi.mjs";

export const MAX_WINDOW = 4096;
export const WINDOW_OVERLAP = 128;

export function windowsOf(total, size = MAX_WINDOW, overlap = WINDOW_OVERLAP) {
  if (total <= size) return total ? [{ start: 0, end: total, ownStart: 0, ownEnd: total }] : [];
  const stride = size - overlap;
  const half = Math.floor(overlap / 2);
  const windows = [];
  for (let start = 0; ; start += stride) {
    const end = Math.min(start + size, total);
    const last = end === total;
    windows.push({ start, end, ownStart: start === 0 ? 0 : start + half, ownEnd: last ? total : end - overlap + half });
    if (last) return windows;
  }
}

export function createClassifier({ llama, tensors, headConfig, window = MAX_WINDOW, overlap = WINDOW_OVERLAP }) {
  const labels = headConfig.labels;
  const head = tokenHead(tensors, labels.length, headConfig.hidden_size);
  const decoder = createDecoder(labels, { bBias: headConfig.viterbi_b_bias ?? 0, eBias: headConfig.viterbi_e_bias ?? 0 });

  async function classify(text) {
    if (!text.trim()) return { spans: [], tokens: 0 };
    const tokens = await llama.tokenize(text);
    const { offsets, points } = tokenOffsets(text, tokens.map((token) => token.piece));
    const ids = tokens.map((token) => token.id);
    const spans = [];
    for (const part of windowsOf(ids.length, window, overlap)) {
      const states = await llama.embed(ids.slice(part.start, part.end));
      if (states.length !== part.end - part.start) {
        throw Object.assign(new Error("embeddings returned a different token count"), { code: "TOKENIZATION_MISMATCH" });
      }
      for (const span of decoder.decode(tokenLogits(head, states))) {
        const first = span.first + part.start;
        if (first < part.ownStart || first >= part.ownEnd) continue;
        const range = trimSpan(points, offsets[first][0], offsets[span.last + part.start][1]);
        if (range) spans.push({ entity_group: span.label, score: Number(span.score.toFixed(4)), start: range[0], end: range[1] });
      }
    }
    return { spans, tokens: ids.length };
  }

  return { classify, labels: decoder.types };
}
