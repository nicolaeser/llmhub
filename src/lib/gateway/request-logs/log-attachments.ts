import { createHash } from "node:crypto";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 16;
export const ATTACHMENT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const ATTACHMENT_MARKER = "llmhub-attachment:";

const MIN_DATA_URL_CHARS = 32;
const MIN_RAW_BASE64_CHARS = 513;
const MAX_DEPTH = 32;
const DATA_URL = /^data:[^,]{0,200};base64,/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MARKER = /^llmhub-attachment:([0-9a-f]{64});([a-z]+\/[a-z0-9.+-]+)$/;

export type ExtractedAttachment = { id: string; contentType: string; payload: Buffer };

export type AttachmentRef = { id: string; contentType: string };

type Budget = { count: number; total: number; files: Map<string, ExtractedAttachment> };

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Buffer, text: string, offset = 0): boolean {
  return startsWith(bytes, [...text].map((char) => char.charCodeAt(0)), offset);
}

export function sniffAttachmentType(bytes: Buffer): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "image/gif";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "image/webp";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WAVE", 8)) return "audio/wav";
  if (ascii(bytes, "%PDF-")) return "application/pdf";
  if (ascii(bytes, "ID3") || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) return "audio/mpeg";
  if (ascii(bytes, "OggS")) return "audio/ogg";
  if (ascii(bytes, "fLaC")) return "audio/flac";
  return null;
}

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "audio/wav", "audio/mpeg", "audio/ogg", "audio/flac"]);
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "application/pdf": "pdf",
};

export function attachmentHeaders(id: string, contentType: string): Record<string, string> {
  const known = EXTENSIONS[contentType];
  const name = `attachment-${id.slice(0, 12)}.${known ?? "bin"}`;
  return {
    "Content-Type": known ? contentType : "application/octet-stream",
    "Content-Disposition": `${INLINE_TYPES.has(contentType) ? "inline" : "attachment"}; filename="${name}"`,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  };
}

export function attachmentMarker(ref: AttachmentRef): string {
  return `${ATTACHMENT_MARKER}${ref.id};${ref.contentType}`;
}

export function attachmentRefOf(value: unknown): AttachmentRef | null {
  if (typeof value !== "string" || !value.startsWith(ATTACHMENT_MARKER)) return null;
  const match = MARKER.exec(value);
  return match ? { id: match[1]!, contentType: match[2]! } : null;
}

function encodedPart(value: string): string | null {
  const prefix = DATA_URL.exec(value);
  if (value.length < (prefix ? MIN_DATA_URL_CHARS : MIN_RAW_BASE64_CHARS)) return null;
  const encoded = prefix ? value.slice(prefix[0].length) : value;
  return BASE64.test(encoded) ? encoded : null;
}

function capture(value: string, budget: Budget): string | null {
  const encoded = encodedPart(value);
  if (!encoded || budget.count >= ATTACHMENT_MAX_COUNT) return null;
  if (Math.floor((encoded.length * 3) / 4) > ATTACHMENT_MAX_BYTES + 3) return null;
  const payload = Buffer.from(encoded, encoded.includes("-") || encoded.includes("_") ? "base64url" : "base64");
  const contentType = sniffAttachmentType(payload);
  if (!contentType || payload.byteLength > ATTACHMENT_MAX_BYTES) return null;
  const id = createHash("sha256").update(payload).digest("hex");
  if (!budget.files.has(id)) {
    if (budget.total + payload.byteLength > ATTACHMENT_MAX_TOTAL_BYTES) return null;
    budget.total += payload.byteLength;
    budget.files.set(id, { id, contentType, payload });
  }
  budget.count += 1;
  return attachmentMarker({ id, contentType });
}

function walk(value: unknown, budget: Budget, depth: number): unknown {
  if (typeof value === "string") return capture(value, budget) ?? value;
  if (depth >= MAX_DEPTH || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = walk(item, budget, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = walk(item, budget, depth + 1);
    if (next === item) continue;
    out ??= { ...(value as Record<string, unknown>) };
    out[key] = next;
  }
  return out ?? value;
}

export function extractAttachments(request: unknown, response: unknown): {
  request: unknown;
  response: unknown;
  files: ExtractedAttachment[];
} {
  const budget: Budget = { count: 0, total: 0, files: new Map() };
  const nextRequest = walk(request, budget, 0);
  const nextResponse = walk(response, budget, 0);
  return { request: nextRequest, response: nextResponse, files: [...budget.files.values()] };
}
