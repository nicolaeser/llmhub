import "server-only";

export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function clientIp(headers: Headers): string {
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? "";
}

const MAX_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function tooLarge(): Error {
  return Object.assign(new Error("request body is too large"), { status: 413 });
}

export function assertContentLength(req: Request, limit: number): void {
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw tooLarge();
}

export async function readJSON<T = unknown>(req: Request, limit = MAX_JSON_BYTES): Promise<T> {
  assertContentLength(req, limit);
  if (!req.body) return {} as T;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}

export function bytesBody(bytes: Uint8Array | Buffer): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}
