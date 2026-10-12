import type { TermBag } from "@/types/rag";

const WORD = /[\p{L}\p{N}]+/gu;
const DIGIT = /\p{N}/u;
const MAX_TERM_LENGTH = 64;
const MAX_QUERY_TERMS = 32;
const MAX_FREQ = 0xffff;
const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  const folded = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
  const out: string[] = [];
  for (const match of folded.matchAll(WORD)) {
    const term = match[0];
    if (term.length < 2 && !DIGIT.test(term)) continue;
    out.push(term.length > MAX_TERM_LENGTH ? term.slice(0, MAX_TERM_LENGTH) : term);
  }
  return out;
}

export function termHash(term: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function termBag(text: string): TermBag {
  const counts = new Map<number, number>();
  const terms = tokenize(text);
  for (const term of terms) {
    const hash = termHash(term);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  const hashes = Uint32Array.from(counts.keys()).sort();
  const freqs = new Uint16Array(hashes.length);
  hashes.forEach((hash, i) => {
    freqs[i] = Math.min(MAX_FREQ, counts.get(hash) ?? 0);
  });
  return { hashes, freqs, length: terms.length };
}

export function encodeTerms(bag: TermBag): Uint8Array {
  const n = bag.hashes.length;
  const view = new DataView(new ArrayBuffer(8 + n * 6));
  view.setUint32(0, n, true);
  view.setUint32(4, bag.length, true);
  for (let i = 0; i < n; i++) {
    view.setUint32(8 + i * 4, bag.hashes[i]!, true);
    view.setUint16(8 + n * 4 + i * 2, bag.freqs[i]!, true);
  }
  return new Uint8Array(view.buffer);
}

export function decodeTerms(bytes: Uint8Array): TermBag {
  if (bytes.byteLength < 8) return { hashes: new Uint32Array(), freqs: new Uint16Array(), length: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.min(view.getUint32(0, true), Math.floor((bytes.byteLength - 8) / 6));
  const hashes = new Uint32Array(n);
  const freqs = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    hashes[i] = view.getUint32(8 + i * 4, true);
    freqs[i] = view.getUint16(8 + n * 4 + i * 2, true);
  }
  return { hashes, freqs, length: view.getUint32(4, true) };
}

export function queryTerms(queries: string[]): number[] {
  const unique = new Set<number>();
  for (const query of queries) {
    for (const term of tokenize(query)) {
      unique.add(termHash(term));
      if (unique.size >= MAX_QUERY_TERMS) return [...unique];
    }
  }
  return [...unique];
}

export function frequencyIn(hashes: Uint32Array, freqs: Uint16Array, from: number, to: number, hash: number): number {
  let lo = from;
  let hi = to - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = hashes[mid]!;
    if (value === hash) return freqs[mid]!;
    if (value < hash) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

export function bm25(tf: number, df: number, docs: number, length: number, avgLength: number): number {
  if (!tf || !df || !docs) return 0;
  const idf = Math.log(1 + (docs - df + 0.5) / (df + 0.5));
  const norm = avgLength > 0 ? length / avgLength : 1;
  return (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm));
}
