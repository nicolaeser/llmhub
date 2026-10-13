import "server-only";

import { authorizationHeader, sha256Hex } from "@/lib/s3/sign";
import { readTextOr } from "@/lib/utils/json";
import { objectUrl, publicObjectUrl } from "@/lib/s3/url";
import type { S3Runtime } from "@/types/s3";

export class S3Error extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    body: string,
  ) {
    const code = body.match(/<Code>([^<]{1,80})<\/Code>/)?.[1] ?? "";
    super(code || `s3 ${status}`);
    this.name = "S3Error";
    this.code = code;
  }
}

async function signedFetch(
  runtime: S3Runtime,
  method: string,
  key: string,
  opts?: { body?: Uint8Array; contentType?: string; signal?: AbortSignal },
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
    headers: extra,
    bodySha256: sha256Hex(body ? Buffer.from(body) : ""),
  });
  const headers = new Headers(signed.headers);
  headers.set("Authorization", signed.authorization);
  return fetch(url, {
    method,
    headers,
    body: body ? Buffer.from(body) : undefined,
    redirect: "manual",
    signal: opts?.signal,
  });
}

async function failure(res: Response): Promise<S3Error> {
  return new S3Error(res.status, (await readTextOr(res)).slice(0, 2000));
}

export async function s3Put(
  runtime: S3Runtime,
  key: string,
  body: Uint8Array | Buffer,
  contentType = "application/octet-stream",
  signal?: AbortSignal,
): Promise<void> {
  const res = await signedFetch(runtime, "PUT", key, { body: Buffer.from(body), contentType, signal });
  if (!res.ok) throw await failure(res);
}

export async function s3Get(
  runtime: S3Runtime,
  key: string,
  signal?: AbortSignal,
): Promise<{ body: Uint8Array; contentType: string }> {
  const res = await signedFetch(runtime, "GET", key, { signal });
  if (!res.ok) throw await failure(res);
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

export async function s3Delete(runtime: S3Runtime, key: string, signal?: AbortSignal): Promise<void> {
  const res = await signedFetch(runtime, "DELETE", key, { signal });
  if (res.status === 404) return;
  if (!res.ok) throw await failure(res);
}

export function s3PublicUrl(runtime: S3Runtime, key: string): string {
  return publicObjectUrl(runtime, key);
}
