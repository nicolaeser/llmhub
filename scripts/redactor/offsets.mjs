import { Buffer } from "node:buffer";

const TRIMMED = new Set([" ", "\t", "\n", "\r"]);

function mismatch(message) {
  return Object.assign(new Error(message), { code: "TOKENIZATION_MISMATCH" });
}

export function pieceBytes(piece) {
  if (typeof piece === "string") return Buffer.byteLength(piece, "utf8");
  if (Array.isArray(piece) && piece.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)) return piece.length;
  throw mismatch("token piece is neither text nor bytes");
}

export function codePoints(text) {
  return Array.from(text);
}

export function tokenOffsets(text, pieces) {
  const points = codePoints(text);
  const pointAtByte = [];
  let bytes = 0;
  points.forEach((point, index) => {
    const width = Buffer.byteLength(point, "utf8");
    for (let k = 0; k < width; k++) pointAtByte.push(index);
    bytes += width;
  });
  pointAtByte.push(points.length);
  const boundary = (byte) => byte === bytes || pointAtByte[byte] !== pointAtByte[byte - 1];
  const offsets = [];
  let cursor = 0;
  for (const piece of pieces) {
    const width = pieceBytes(piece);
    const startByte = cursor;
    cursor += width;
    if (cursor > bytes) throw mismatch("tokens cover more bytes than the text");
    const start = pointAtByte[startByte];
    const end = width === 0 ? start : boundary(cursor) ? pointAtByte[cursor] : pointAtByte[cursor - 1] + 1;
    offsets.push([start, end]);
  }
  if (cursor !== bytes) throw mismatch("tokens do not cover the text");
  return { offsets, points };
}

export function trimSpan(points, start, end) {
  let from = start;
  let to = end;
  while (from < to && TRIMMED.has(points[from])) from++;
  while (to > from && TRIMMED.has(points[to - 1])) to--;
  return from < to ? [from, to] : null;
}
