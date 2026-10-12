const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values, (value) => (Number.isFinite(value) ? value : 0));
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i]! * out[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

export function encodeVector(vector: Float32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
  const view = new DataView(new ArrayBuffer(vector.length * 4));
  vector.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return new Uint8Array(view.buffer);
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  const length = Math.floor(bytes.byteLength / 4);
  if (LITTLE_ENDIAN) {
    const copy = new Uint8Array(length * 4);
    copy.set(bytes.subarray(0, length * 4));
    return new Float32Array(copy.buffer);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length }, (_, i) => view.getFloat32(i * 4, true));
}

export function quantizeInto(vector: Float32Array, target: Int8Array, offset: number): number {
  let max = 0;
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]!));
  if (max === 0) return 0;
  const factor = 127 / max;
  for (let i = 0; i < vector.length; i++) target[offset + i] = Math.round(vector[i]! * factor);
  return max / 127;
}

export function quantizedDot(
  query: Float32Array,
  data: Int8Array,
  offset: number,
  dims: number,
  scale: number,
): number {
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += query[i]! * data[offset + i]!;
  return sum * scale;
}

export function parseEmbedding(value: unknown): Float32Array | null {
  if (Array.isArray(value)) {
    if (!value.length || !value.every((item) => typeof item === "number")) return null;
    return normalizeVector(value as number[]);
  }
  if (typeof value === "string" && value) {
    const bytes = Buffer.from(value, "base64");
    if (!bytes.byteLength || bytes.byteLength % 4) return null;
    return normalizeVector(decodeVector(bytes));
  }
  return null;
}
