import "server-only";
import { cancelQuietly } from "@/lib/utils/streams";

export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

const MAX_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function tooLarge(): Error {
  return Object.assign(new Error("request body is too large"), { status: 413 });
}

export function isPayloadTooLarge(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { status?: unknown }).status === 413;
}

export function assertContentLength(req: Request, limit: number): void {
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw tooLarge();
}

async function readCapped(req: Request, limit: number): Promise<Buffer> {
  assertContentLength(req, limit);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await cancelQuietly(reader);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readText(req: Request, limit: number): Promise<string> {
  return (await readCapped(req, limit)).toString("utf8");
}

export async function readJSON<T = unknown>(req: Request, limit = MAX_JSON_BYTES): Promise<T> {
  const text = await readText(req, limit);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function readForm(req: Request, limit: number): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new Error("UNSUPPORTED_MEDIA_TYPE");
  const body = bytesBody(await readCapped(req, limit));
  try {
    return await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (err) {
    throw new Error("BAD_REQUEST", { cause: err });
  }
}

export function bytesBody(bytes: Uint8Array | Buffer): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}
