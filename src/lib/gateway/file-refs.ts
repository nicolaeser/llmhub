import "server-only";
import { asRecord } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, getObject } from "@/lib/gateway/objects";
import type { JsonMap, Principal } from "@/types/gateway";

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

export function mediaTypeOf(contentType: string, filename: string): string {
  const declared = contentType.split(";")[0]?.trim() ?? "";
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

async function storedFile(id: string, principal: Principal): Promise<{ dataUrl: string; filename: string } | null> {
  const object = await getObject(id);
  if (!object || object.kind !== "file" || !canReadObject(object, principal)) return null;
  const media = mediaTypeOf(object.contentType, object.filename);
  return {
    dataUrl: `data:${media};base64,${Buffer.from(object.payload).toString("base64")}`,
    filename: object.filename,
  };
}

function notFound(id: string): GateError {
  return new GateError(400, "file_not_found", `file '${id}' not found`);
}

async function resolveResponsesPart(part: JsonMap, principal: Principal): Promise<JsonMap> {
  if (part.type === "input_image" && !part.image_url && typeof part.file_id === "string" && part.file_id) {
    const file = await storedFile(part.file_id, principal);
    if (!file) throw notFound(part.file_id);
    const resolved: JsonMap = { ...part, image_url: file.dataUrl };
    delete resolved.file_id;
    return resolved;
  }
  if (part.type === "input_file" && !part.file_data && typeof part.file_id === "string" && part.file_id) {
    const file = await storedFile(part.file_id, principal);
    if (!file) throw notFound(part.file_id);
    const resolved: JsonMap = { ...part, file_data: file.dataUrl, filename: part.filename || file.filename };
    delete resolved.file_id;
    return resolved;
  }
  return part;
}

async function resolveParts(content: unknown, resolve: (part: JsonMap) => Promise<JsonMap>): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  return Promise.all(
    content.map(async (raw) => {
      const part = asRecord(raw);
      return part ? resolve(part) : raw;
    }),
  );
}

export async function resolveResponsesFiles(body: JsonMap, principal: Principal): Promise<JsonMap> {
  if (!Array.isArray(body.input)) return body;
  const input = await Promise.all(
    body.input.map(async (raw) => {
      const item = asRecord(raw);
      if (!item) return raw;
      const content = await resolveParts(item.content, (part) => resolveResponsesPart(part, principal));
      const output = await resolveParts(item.output, (part) => resolveResponsesPart(part, principal));
      return { ...item, ...(item.content !== undefined ? { content } : {}), ...(item.output !== undefined ? { output } : {}) };
    }),
  );
  return { ...body, input };
}

async function resolveChatPart(part: JsonMap, principal: Principal): Promise<JsonMap> {
  const file = asRecord(part.file);
  if (part.type !== "file" || !file || file.file_data || typeof file.file_id !== "string" || !file.file_id) {
    return part;
  }
  const stored = await storedFile(file.file_id, principal);
  if (!stored) return part;
  const resolved: JsonMap = { ...file, file_data: stored.dataUrl, filename: file.filename || stored.filename };
  delete resolved.file_id;
  return { ...part, file: resolved };
}

export async function resolveChatFiles(body: JsonMap, principal: Principal): Promise<JsonMap> {
  if (!Array.isArray(body.messages)) return body;
  const messages = await Promise.all(
    body.messages.map(async (raw) => {
      const message = asRecord(raw);
      if (!message || !Array.isArray(message.content)) return raw;
      return { ...message, content: await resolveParts(message.content, (part) => resolveChatPart(part, principal)) };
    }),
  );
  return { ...body, messages };
}

async function resolveImageRef(ref: unknown, principal: Principal): Promise<unknown> {
  const rec = asRecord(ref);
  if (!rec || rec.image_url || typeof rec.file_id !== "string" || !rec.file_id) return ref;
  const stored = await storedFile(rec.file_id, principal);
  if (!stored) return ref;
  const resolved: JsonMap = { ...rec, image_url: stored.dataUrl };
  delete resolved.file_id;
  return resolved;
}

export async function resolveImageFiles(body: JsonMap, principal: Principal): Promise<JsonMap> {
  const out: JsonMap = { ...body };
  if (Array.isArray(body.images)) {
    out.images = await Promise.all(body.images.map((ref) => resolveImageRef(ref, principal)));
  }
  if (body.mask !== undefined) out.mask = await resolveImageRef(body.mask, principal);
  return out;
}
