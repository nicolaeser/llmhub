import "server-only";

import { authorizationHeader, sha256Hex } from "@/lib/s3/sign";
import { objectUrl, publicObjectUrl } from "@/lib/s3/url";
import type { S3Runtime } from "@/types/s3";

class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

async function signedFetch(
  runtime: S3Runtime,
  method: string,
  key: string,
  opts?: { body?: Uint8Array; contentType?: string },
): Promise<Response> {
  const url = objectUrl(runtime, key);
  const body = opts?.body;
  const extra: Record<string, string> = {};
  if (opts?.contentType) extra["content-type"] = opts.contentType;
  const signed = authorizationHeader({
    method,
    url,
    region: runtime.region,
    accessKeyId: runtime.accessKeyId,
    secretAccessKey: runtime.secretAccessKey,
    sessionToken: runtime.sessionToken || undefined,
    headers: extra,
    bodySha256: sha256Hex(body ? Buffer.from(body) : ""),
  });
  const headers = new Headers(signed.headers);
  headers.set("Authorization", signed.authorization);
  return fetch(url, {
    method,
    headers,
    body: body ? Buffer.from(body) : undefined,
  });
}

export async function s3Put(
  runtime: S3Runtime,
  key: string,
  body: Uint8Array | Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  const res = await signedFetch(runtime, "PUT", key, {
    body: Buffer.from(body),
    contentType,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new S3Error(res.status, text.slice(0, 400) || `s3 put ${res.status}`);
  }
}

export async function s3Get(
  runtime: S3Runtime,
  key: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const res = await signedFetch(runtime, "GET", key);
  if (res.status === 404) throw new S3Error(404, "s3 object not found");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new S3Error(res.status, text.slice(0, 400) || `s3 get ${res.status}`);
  }
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

export async function s3Delete(runtime: S3Runtime, key: string): Promise<void> {
  const res = await signedFetch(runtime, "DELETE", key);
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new S3Error(res.status, text.slice(0, 400) || `s3 delete ${res.status}`);
  }
}

export function s3PublicUrl(runtime: S3Runtime, key: string): string {
  return publicObjectUrl(runtime, key);
}
