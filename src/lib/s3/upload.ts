import "server-only";

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { S3Error, s3Request } from "@/lib/s3/client";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { S3Runtime } from "@/types/s3";

export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;
export const UPLOAD_MAX_PARTS = 10_000;

const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 1_000;
const TRANSIENT_CODES = new Set(["RequestTimeout", "SlowDown", "InternalError", "ServiceUnavailable"]);

export type UploadStreamOptions = {
  contentType: string;
  headers?: Record<string, string>;
  partBytes?: number;
  retryBaseMs?: number;
};

export type UploadStreamResult = { bytes: number; sha256: string; parts: number };

export function contentMd5(body: Uint8Array): string {
  return createHash("md5").update(body).digest("base64");
}

export function isTransientS3Error(err: unknown): boolean {
  if (!(err instanceof S3Error)) return true;
  return err.status >= 500 || err.status === 429 || TRANSIENT_CODES.has(err.code);
}

async function withRetry<T>(run: () => Promise<T>, baseMs: number): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= REQUEST_ATTEMPTS || !isTransientS3Error(err)) throw err;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

function xmlValue(body: string, tag: string): string {
  return body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "";
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function completeMultipartBody(etags: readonly string[]): string {
  const parts = etags
    .map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`)
    .join("");
  return `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts}</CompleteMultipartUpload>`;
}

function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export async function s3UploadStream(
  runtime: S3Runtime,
  key: string,
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: UploadStreamOptions,
): Promise<UploadStreamResult> {
  const partBytes = Math.max(5 * 1024 * 1024, options.partBytes ?? UPLOAD_PART_BYTES);
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const extraHeaders = options.headers ?? {};
  const hash = createHash("sha256");
  const etags: string[] = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  let uploadId = "";

  const create = async () => {
    const res = await withRetry(
      () =>
        s3Request(runtime, "POST", key, {
          query: { uploads: "" },
          contentType: options.contentType,
          headers: extraHeaders,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      retryBaseMs,
    );
    const id = xmlValue(await res.text(), "UploadId");
    if (!id) throw new S3Error(502, "<Code>MissingUploadId</Code>");
    return id;
  };

  const flush = async () => {
    const part = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    if (!uploadId) uploadId = await create();
    if (etags.length >= UPLOAD_MAX_PARTS) throw new S3Error(400, "<Code>EntityTooLarge</Code>");
    const partNumber = etags.length + 1;
    const res = await withRetry(
      () =>
        s3Request(runtime, "PUT", key, {
          body: part,
          query: { partNumber: String(partNumber), uploadId },
          headers: { "content-md5": contentMd5(part) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      retryBaseMs,
    );
    const etag = res.headers.get("etag");
    if (!etag) throw new S3Error(502, "<Code>MissingETag</Code>");
    etags.push(etag);
  };

  const complete = async () => {
    const res = await withRetry(
      () =>
        s3Request(runtime, "POST", key, {
          body: Buffer.from(completeMultipartBody(etags)),
          contentType: "application/xml",
          query: { uploadId },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      retryBaseMs,
    );
    const text = await res.text();
    if (text.includes("<Error>")) throw new S3Error(500, text.slice(0, 2000));
  };

  const abort = async () => {
    try {
      await s3Request(runtime, "DELETE", key, { query: { uploadId }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      logger.warn("s3.multipart_abort_failed", errorFields(err));
    }
  };

  try {
    for await (const chunk of body) {
      const buffer = asBuffer(chunk);
      if (!buffer.length) continue;
      hash.update(buffer);
      total += buffer.length;
      pending.push(buffer);
      pendingBytes += buffer.length;
      if (pendingBytes >= partBytes) await flush();
    }
    if (!uploadId) {
      const single = Buffer.concat(pending, pendingBytes);
      pending = [];
      await withRetry(
        () =>
          s3Request(runtime, "PUT", key, {
            body: single,
            contentType: options.contentType,
            headers: { ...extraHeaders, "content-md5": contentMd5(single) },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        retryBaseMs,
      );
      return { bytes: total, sha256: hash.digest("hex"), parts: 1 };
    }
    if (pendingBytes > 0) await flush();
    await complete();
    return { bytes: total, sha256: hash.digest("hex"), parts: etags.length };
  } catch (err) {
    if (uploadId) await abort();
    throw err;
  }
}
