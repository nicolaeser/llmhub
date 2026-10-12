import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CHUNK_TOKENS, AUTO_OVERLAP_TOKENS, chunkSettings, chunkText, chunkingJson, normalizeText } from "@/lib/rag/chunking";
import { buildFileIndex } from "@/lib/rag/file-index";
import { attributesOf, matchesFilter } from "@/lib/rag/filters";
import { bm25, decodeTerms, encodeTerms, frequencyIn, queryTerms, termBag, termHash, tokenize } from "@/lib/rag/lexical";
import { rankingOptions, scoreFiles } from "@/lib/rag/rank";
import { decodeVector, encodeVector, normalizeVector, parseEmbedding, quantizedDot, quantizeInto } from "@/lib/rag/vectors";
import type { IndexedFile } from "@/types/rag";

test("chunkSettings follows OpenAI auto and static strategies and store defaults", () => {
  assert.deepEqual(chunkSettings(null), { type: "auto", maxTokens: AUTO_CHUNK_TOKENS, overlapTokens: AUTO_OVERLAP_TOKENS });
  assert.deepEqual(chunkSettings({ type: "auto" }, { maxTokens: 300, overlapTokens: 50 }), {
    type: "auto",
    maxTokens: 800,
    overlapTokens: 400,
  });
  assert.deepEqual(
    chunkSettings({ type: "static", static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 20 } }),
    { type: "static", maxTokens: 200, overlapTokens: 20 },
  );
  assert.deepEqual(chunkSettings(undefined, { maxTokens: 300, overlapTokens: 50 }), {
    type: "static",
    maxTokens: 300,
    overlapTokens: 50,
  });
  assert.deepEqual(chunkingJson({ maxTokens: 800, overlapTokens: 400 }), {
    type: "static",
    static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 },
  });
});

test("chunkText keeps chunks under the size, overlaps them, and prefers paragraph breaks", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"lorem ipsum dolor ".repeat(12)}`.trim());
  const text = paragraphs.join("\n\n");
  const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 20 });
  assert.ok(chunks.length > 5);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 400, `chunk too long: ${chunk.text.length}`);
  assert.deepEqual(
    chunks.map((chunk) => chunk.position),
    chunks.map((_, i) => i),
  );
  assert.ok(chunks.slice(0, -1).every((chunk) => /[a-z0-9]$/i.test(chunk.text)));
  const joined = chunks.map((chunk) => chunk.text).join(" ");
  for (const paragraph of paragraphs) assert.ok(joined.includes(paragraph.slice(0, 30)));
  const [first, second] = chunks;
  const tail = first!.text.slice(-30);
  assert.ok(second!.text.includes(tail.split(" ").slice(-2).join(" ")), "consecutive chunks overlap");
});

test("chunkText always advances on text without break points and drops blank input", () => {
  const chunks = chunkText("x".repeat(1000), { maxTokens: 100, overlapTokens: 50 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunkText("   \n\n  ", { maxTokens: 100, overlapTokens: 0 }).length, 0);
  assert.equal(normalizeText("a\r\nb\u0000\n\n\n\nc  \n"), "a\nb\n\nc");
});

test("tokenize folds case and diacritics and drops one-letter words", () => {
  assert.deepEqual(tokenize("Müller kauft 3 Äpfel, a B."), ["muller", "kauft", "3", "apfel"]);
  assert.equal(termHash("muller"), termHash("muller"));
  assert.notEqual(termHash("muller"), termHash("mueller"));
});

test("term bags round-trip through bytes and support frequency lookups", () => {
  const bag = termBag("Invoice invoice INVOICE refund");
  assert.equal(bag.length, 4);
  const decoded = decodeTerms(encodeTerms(bag));
  assert.deepEqual([...decoded.hashes], [...bag.hashes]);
  assert.deepEqual([...decoded.freqs], [...bag.freqs]);
  assert.equal(decoded.length, 4);
  assert.equal(frequencyIn(decoded.hashes, decoded.freqs, 0, decoded.hashes.length, termHash("invoice")), 3);
  assert.equal(frequencyIn(decoded.hashes, decoded.freqs, 0, decoded.hashes.length, termHash("missing")), 0);
  assert.deepEqual(decodeTerms(new Uint8Array(3)).length, 0);
  assert.equal(queryTerms(["refund refund", "invoice"]).length, 2);
});

test("bm25 rewards frequent and rare terms", () => {
  assert.equal(bm25(0, 1, 10, 10, 10), 0);
  assert.ok(bm25(3, 1, 10, 10, 10) > bm25(1, 1, 10, 10, 10));
  assert.ok(bm25(1, 1, 10, 10, 10) > bm25(1, 9, 10, 10, 10));
});

test("vectors normalize, round-trip, and quantize close to the exact cosine", () => {
  const a = normalizeVector([3, 4, 0, 1]);
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-6);
  assert.deepEqual([...decodeVector(encodeVector(a))], [...a]);
  const b = normalizeVector([2, 5, 1, 0]);
  const exact = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  const store = new Int8Array(4);
  const scale = quantizeInto(b, store, 0);
  assert.ok(Math.abs(quantizedDot(a, store, 0, 4, scale) - exact) < 0.02);
  const base64 = Buffer.from(encodeVector(new Float32Array([0, 2]))).toString("base64");
  assert.deepEqual([...parseEmbedding(base64)!], [0, 1]);
  assert.equal(parseEmbedding(["x"]), null);
  assert.equal(parseEmbedding("abc"), null);
});

test("attribute filters follow comparison and compound semantics", () => {
  const attrs = attributesOf({ region: "eu", year: 2026, draft: false, nested: { no: true } });
  assert.deepEqual(Object.keys(attrs), ["region", "year", "draft"]);
  assert.equal(matchesFilter(attrs, null), true);
  assert.equal(matchesFilter(attrs, { type: "eq", key: "region", value: "eu" }), true);
  assert.equal(matchesFilter(attrs, { type: "ne", key: "region", value: "eu" }), false);
  assert.equal(matchesFilter(attrs, { type: "ne", key: "missing", value: "eu" }), true);
  assert.equal(matchesFilter(attrs, { type: "gte", key: "year", value: 2026 }), true);
  assert.equal(matchesFilter(attrs, { type: "lt", key: "year", value: "2027" }), false);
  assert.equal(matchesFilter(attrs, { type: "in", key: "region", value: ["us", "eu"] }), true);
  assert.equal(matchesFilter(attrs, { type: "nin", key: "region", value: ["eu"] }), false);
  assert.equal(
    matchesFilter(attrs, {
      type: "and",
      filters: [
        { type: "eq", key: "draft", value: false },
        { type: "or", filters: [{ type: "eq", key: "region", value: "us" }, { type: "gt", key: "year", value: 2000 }] },
      ],
    }),
    true,
  );
});

function indexed(fileId: string, texts: string[], vectors: number[][]): IndexedFile {
  const rows = texts.map((text, i) => ({
    id: `${fileId}-${i}`,
    position: i,
    embedding: encodeVector(normalizeVector(vectors[i]!)),
    terms: encodeTerms(termBag(text)),
  }));
  return { fileId, filename: `${fileId}.txt`, attributes: {}, index: buildFileIndex(rows, 3, 1) };
}

test("scoreFiles blends cosine similarity with keyword matches unless the ranker is none", () => {
  const files = [
    indexed("a", ["password reset steps", "holiday calendar"], [
      [1, 0, 0],
      [0, 1, 0],
    ]),
    indexed("b", ["error code XK-42 means expired token"], [[0.7, 0.7, 0]]),
  ];
  const query = normalizeVector([0.9, 0.1, 0]);
  const terms = queryTerms(["XK-42"]);
  const hybrid = scoreFiles(files, query, terms, rankingOptions(null)).sort((x, y) => y.score - x.score);
  assert.equal(hybrid[0]!.file.fileId, "b");
  const vectorOnly = scoreFiles(files, query, terms, rankingOptions({ ranker: "none" })).sort((x, y) => y.score - x.score);
  assert.equal(vectorOnly[0]!.file.fileId, "a");
  assert.ok(vectorOnly.every((hit) => hit.score <= 1));
  assert.equal(scoreFiles(files, normalizeVector([1, 0]), [], rankingOptions(null)).length, 0);
});

test("rankingOptions applies OpenAI defaults and hybrid weights", () => {
  assert.deepEqual(rankingOptions(undefined), { ranker: "auto", scoreThreshold: 0, embeddingWeight: 0.7, textWeight: 0.3 });
  assert.deepEqual(
    rankingOptions({ ranker: "none", score_threshold: 0.5, hybrid_search: { embedding_weight: 1, text_weight: 2 } }),
    { ranker: "none", scoreThreshold: 0.5, embeddingWeight: 1, textWeight: 2 },
  );
});
