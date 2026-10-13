import "server-only";

import { randomUUID } from "node:crypto";
import { S3Error, s3Delete, s3Get, s3Put } from "@/lib/s3/client";
import { joinKey } from "@/lib/s3/url";
import type { S3ProbeCode, S3ProbeResult, S3ProbeStep, S3Runtime } from "@/types/s3";

const PROBE_TIMEOUT_MS = 10_000;

const CODE_BY_S3_ERROR: Record<string, S3ProbeCode> = {
  InvalidAccessKeyId: "AUTH",
  InvalidToken: "AUTH",
  ExpiredToken: "AUTH",
  SignatureDoesNotMatch: "SIGNATURE",
  AccessDenied: "DENIED",
  AllAccessDisabled: "DENIED",
  AccountProblem: "DENIED",
  NoSuchBucket: "NO_BUCKET",
  PermanentRedirect: "REGION",
  AuthorizationHeaderMalformed: "REGION",
  IllegalLocationConstraintException: "REGION",
  InvalidRegion: "REGION",
};

export function s3ProbeCode(err: unknown): { code: S3ProbeCode; status: number | null } {
  if (!(err instanceof S3Error)) return { code: "UNREACHABLE", status: null };
  const known = CODE_BY_S3_ERROR[err.code];
  if (known) return { code: known, status: err.status };
  if (err.status >= 300 && err.status < 400) return { code: "REGION", status: err.status };
  if (err.status === 401) return { code: "AUTH", status: err.status };
  if (err.status === 403) return { code: "DENIED", status: err.status };
  return { code: "FAILED", status: err.status };
}

export async function probeStorage(runtime: S3Runtime): Promise<S3ProbeResult> {
  const key = joinKey("llmhub-probe", `${randomUUID()}.txt`);
  const body = Buffer.from(`llmhub storage probe ${new Date().toISOString()}\n`);
  const started = Date.now();
  let step: S3ProbeStep = "put";
  try {
    await s3Put(runtime, key, body, "text/plain", AbortSignal.timeout(PROBE_TIMEOUT_MS));
    step = "get";
    const got = await s3Get(runtime, key, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    const matches = Buffer.from(got.body).equals(body);
    step = "delete";
    await s3Delete(runtime, key, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (!matches) return { ok: false, code: "MISMATCH", step: "get", status: null };
    return { ok: true, latencyMs: Date.now() - started, key: joinKey(runtime.prefix, key) };
  } catch (err) {
    return { ok: false, step, ...s3ProbeCode(err) };
  }
}
