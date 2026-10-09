import { decodeTerms } from "@/lib/rag/lexical";
import { decodeVector, quantizeInto } from "@/lib/rag/vectors";
import type { FileIndex } from "@/types/rag";

export function buildFileIndex(
  rows: { id: string; position: number; embedding: Uint8Array; terms: Uint8Array }[],
  dims: number,
  stamp: number,
): FileIndex {
  const n = rows.length;
  const vectors = new Int8Array(n * dims);
  const scales = new Float32Array(n);
  const positions = new Int32Array(n);
  const lengths = new Uint32Array(n);
  const termStarts = new Uint32Array(n + 1);
  const bags = rows.map((row) => decodeTerms(row.terms));
  const totalTerms = bags.reduce((sum, bag) => sum + bag.hashes.length, 0);
  const termHashes = new Uint32Array(totalTerms);
  const termFreqs = new Uint16Array(totalTerms);
  let cursor = 0;
  rows.forEach((row, i) => {
    positions[i] = row.position;
    const vector = decodeVector(row.embedding);
    scales[i] = vector.length === dims ? quantizeInto(vector, vectors, i * dims) : 0;
    const bag = bags[i]!;
    termStarts[i] = cursor;
    termHashes.set(bag.hashes, cursor);
    termFreqs.set(bag.freqs, cursor);
    lengths[i] = bag.length;
    cursor += bag.hashes.length;
  });
  termStarts[n] = cursor;
  const ids = rows.map((row) => row.id);
  return {
    stamp,
    dims,
    ids,
    positions,
    vectors,
    scales,
    termStarts,
    termHashes,
    termFreqs,
    lengths,
    bytes: vectors.byteLength + scales.byteLength + positions.byteLength + lengths.byteLength +
      termStarts.byteLength + termHashes.byteLength + termFreqs.byteLength + ids.length * 40,
  };
}
