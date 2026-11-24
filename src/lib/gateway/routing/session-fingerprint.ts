import "server-only";
import { createHash } from "node:crypto";
import { asArray, asRecord, asString } from "@/lib/gateway/core";
import { clientSessionKey, MAX_SESSION_LENGTH } from "@/lib/gateway/routing/account-affinity";
import { CLAUDE_CODE_BILLING_PREFIX } from "@/lib/gateway/upstreams/claude";
import type { JsonMap } from "@/types/gateway";

export const SESSION_AFFINITY_HEADER = "x-session-affinity";
export const FINGERPRINT_LIMIT_BYTES = 64 * 1024;

export type AffinitySource = "client" | "header" | "fingerprint";

export type AffinityInput = {
  body: JsonMap | null | undefined;
  headers?: Record<string, string>;
  scope: string;
  alias: string;
};

export type AffinitySession = { session: string; source: AffinitySource };

const RAW_SCAN_CHARS = FINGERPRINT_LIMIT_BYTES * 4;
const SESSION_HEX_LENGTH = 32;
const FINGERPRINT_VERSION = "fingerprint:v1";
const AFFINITY_VERSION = "affinity:v1";
const MEDIA_TYPE_CHARS = 64;
const MEDIA_SEARCH_DEPTH = 3;
const TEXT_PART_TYPES = new Set(["text", "input_text"]);
const MEDIA_PART_TYPES = new Set([
  "image",
  "image_url",
  "input_image",
  "audio",
  "audio_url",
  "input_audio",
  "video",
  "video_url",
  "file",
  "input_file",
  "document",
]);
const MEDIA_REF_KEYS = ["data", "url", "file_data", "file_url", "file_id", "image_url"] as const;
const INSTRUCTION_ROLES = new Set(["system", "developer"]);

type Opening = { system: string; user: string };

function digest(fields: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = typeof field === "string" ? Buffer.from(field, "utf8") : field;
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function cappedUtf8(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= FINGERPRINT_LIMIT_BYTES) return bytes;
  let end = FINGERPRINT_LIMIT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function normalizedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function mediaRef(value: unknown, depth: number): string {
  const rec = asRecord(value);
  if (!rec || depth > MEDIA_SEARCH_DEPTH) return "";
  for (const key of MEDIA_REF_KEYS) {
    const ref = asString(rec[key]);
    if (ref) return ref;
  }
  for (const nested of Object.values(rec)) {
    const ref = mediaRef(nested, depth + 1);
    if (ref) return ref;
  }
  return "";
}

function mediaMarker(type: string, part: JsonMap): string {
  const ref = mediaRef(part, 0);
  return `\u0000${type.slice(0, MEDIA_TYPE_CHARS)}:${ref.length}:${digest([ref])}\u0000`;
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const rec = asRecord(part);
  if (!rec) return "";
  const type = asString(rec.type);
  if (TEXT_PART_TYPES.has(type) || (!type && typeof rec.text === "string")) return asString(rec.text);
  if (MEDIA_PART_TYPES.has(type)) return mediaMarker(type, rec);
  return "";
}

function contentText(content: unknown, room: number): string {
  if (room <= 0) return "";
  if (typeof content === "string") return normalizedText(content.slice(0, room));
  const pieces: string[] = [];
  let left = room;
  for (const part of asArray(content)) {
    if (left <= 0) break;
    const piece = partText(part).slice(0, left);
    if (!piece) continue;
    pieces.push(piece);
    left -= piece.length;
  }
  return normalizedText(pieces.join(""));
}

function withoutBillingHeader(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  return system.filter((block) => !asString(asRecord(block)?.text).startsWith(CLAUDE_CODE_BILLING_PREFIX));
}

function isMessageItem(rec: JsonMap): boolean {
  return rec.type === undefined || rec.type === "message";
}

function openingOf(leading: unknown, items: unknown[]): Opening | null {
  const system: string[] = [];
  let used = 0;
  const addSystem = (content: unknown) => {
    const text = contentText(content, RAW_SCAN_CHARS - used);
    if (!text) return;
    system.push(text);
    used += text.length;
  };
  addSystem(leading);
  for (const item of items) {
    const rec = asRecord(item);
    const role = typeof item === "string" ? "user" : asString(rec?.role);
    if (rec && !isMessageItem(rec)) continue;
    if (INSTRUCTION_ROLES.has(role)) {
      addSystem(rec?.content);
      continue;
    }
    if (role !== "user") continue;
    const user = contentText(rec ? rec.content : item, RAW_SCAN_CHARS);
    if (user) return { system: system.join("\n\n"), user };
  }
  return null;
}

function conversationId(value: unknown): string {
  const id = (typeof value === "string" ? value : asString(asRecord(value)?.id)).trim();
  return id.length > MAX_SESSION_LENGTH ? "" : id;
}

function requestOpening(body: JsonMap): Opening | null {
  if (Array.isArray(body.messages)) return openingOf(withoutBillingHeader(body.system), body.messages);
  if (typeof body.input === "string") return openingOf(body.instructions, [body.input]);
  if (Array.isArray(body.input)) return openingOf(body.instructions, body.input);
  return null;
}

export function conversationFingerprint(body: JsonMap | null | undefined): string {
  const rec = asRecord(body);
  if (!rec) return "";
  const conversation = conversationId(rec.conversation);
  if (conversation) return digest([FINGERPRINT_VERSION, "conversation", conversation]);
  if (asString(rec.previous_response_id).trim()) return "";
  const opening = requestOpening(rec);
  if (!opening) return "";
  return digest([FINGERPRINT_VERSION, "opening", cappedUtf8(opening.system), cappedUtf8(opening.user)]);
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof found?.[1] === "string" ? found[1].trim() : "";
}

function affinityKey(body: JsonMap | null | undefined, headers?: Record<string, string>): { value: string; source: AffinitySource } | null {
  const client = clientSessionKey(body, headers);
  if (client) return { value: client, source: "client" };
  const header = headerValue(headers, SESSION_AFFINITY_HEADER);
  if (header && header.length <= MAX_SESSION_LENGTH) return { value: header, source: "header" };
  const fingerprint = conversationFingerprint(body);
  if (fingerprint) return { value: fingerprint, source: "fingerprint" };
  return null;
}

export function affinitySessionSource(input: AffinityInput): AffinitySession | null {
  const key = affinityKey(input.body, input.headers);
  if (!key) return null;
  const session = digest([AFFINITY_VERSION, input.scope, input.alias, key.source, key.value]).slice(0, SESSION_HEX_LENGTH);
  return { session, source: key.source };
}

export function affinitySession(input: AffinityInput): string {
  return affinitySessionSource(input)?.session ?? "";
}
