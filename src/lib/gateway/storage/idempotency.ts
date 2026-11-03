import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isPrismaCode } from "@/lib/auth/errors";
import { gatewayPath } from "@/lib/gateway/api-paths";
import { ownerId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { vaultOf } from "@/lib/gateway/safety/pii-vault";
import { bytesBody } from "@/lib/http/api";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type {
  IdempotencyClaim,
  IdempotencyOutcome,
  IdempotencyReplayMode,
  IdempotencyScope,
  IdempotentRequest,
  Principal,
  UploadFingerprint,
} from "@/types/gateway";

export const IDEMPOTENCY_KIND = "idempotency";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_STALE_MS = 10 * 60 * 1000;
export const IDEMPOTENCY_HEARTBEAT_MS = 60 * 1000;
export const MAX_IDEMPOTENCY_KEYS = 1000;
export const MAX_IDEMPOTENT_BODY_BYTES = 2 * 1024 * 1024;

const PENDING = "pending:";
const DONE = "done";
const CLAIM_ATTEMPTS = 3;
const PURGE_CHUNK = 1000;
const PURGE_CHUNKS = 10;
const KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

const ROW_SELECT = {
  purpose: true,
  contentType: true,
  payload: true,
  meta: true,
  createdAt: true,
} as const;

type IdempotencyRow = Prisma.StoredObjectGetPayload<{ select: typeof ROW_SELECT }>;

const UNREPLAYABLE: Record<Exclude<IdempotencyReplayMode, "body">, string> = {
  too_large: `the original response was larger than ${MAX_IDEMPOTENT_BODY_BYTES} bytes and cannot be replayed`,
  stream: "the original request was streamed and a streamed response cannot be replayed",
  private: "the original response carried restored personal data, which is never stored, so it cannot be replayed",
};

function keyError(message: string): GateError {
  return new GateError(400, "invalid_request", message, { param: IDEMPOTENCY_HEADER, requestScoped: true });
}

function reusedError(message: string): GateError {
  return new GateError(409, "idempotency_key_reused", message, { param: IDEMPOTENCY_HEADER, requestScoped: true });
}

function inProgressError(): GateError {
  return new GateError(
    409,
    "idempotency_key_in_progress",
    "a request with this Idempotency-Key is still in progress; retry after it finished",
    { param: IDEMPOTENCY_HEADER },
  );
}

export function idempotencyKeyOf(headers: Headers): string | null {
  const key = headers.get(IDEMPOTENCY_HEADER);
  if (key === null) return null;
  if (!KEY_PATTERN.test(key)) throw keyError("Idempotency-Key must be 1 to 255 printable ASCII characters");
  return key;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((name) => [name, canonical(record[name])]));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function endpointOf(req: Request): string {
  return gatewayPath(URL.canParse(req.url) ? new URL(req.url).pathname : "");
}

export function requestFingerprint(parts: Record<string, unknown>): string {
  return sha256(JSON.stringify(canonical(parts)));
}

export function jsonFingerprint(req: Request, body: unknown): string {
  return requestFingerprint({ method: req.method, endpoint: endpointOf(req), body });
}

export function uploadFingerprint(req: Request, upload: UploadFingerprint): string {
  return requestFingerprint({
    method: req.method,
    endpoint: endpointOf(req),
    purpose: upload.purpose,
    filename: upload.filename,
    contentType: upload.contentType,
    file: sha256(upload.payload),
  });
}

export function idempotencyScope(req: Request, principal: Principal): IdempotencyScope {
  return { pool: principal.pool ?? "api", owner: ownerId(principal), endpoint: endpointOf(req) };
}

export function idempotencyRowId(scope: IdempotencyScope, key: string): string {
  return `idem_${sha256([scope.pool, scope.owner, scope.endpoint, key].join("\0"))}`;
}

function metaOf(row: IdempotencyRow): Record<string, unknown> {
  return row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? (row.meta as Record<string, unknown>) : {};
}

function abandoned(row: IdempotencyRow, now: number): boolean {
  const age = now - row.createdAt.getTime();
  return age >= IDEMPOTENCY_TTL_MS || (row.purpose.startsWith(PENDING) && age >= IDEMPOTENCY_STALE_MS);
}

async function takeOver(id: string, row: IdempotencyRow, fingerprint: string, now: number): Promise<IdempotencyClaim | null> {
  const lease = randomUUID();
  const taken = await prisma.storedObject.updateMany({
    where: { id, kind: IDEMPOTENCY_KIND, purpose: row.purpose, createdAt: row.createdAt },
    data: {
      purpose: PENDING + lease,
      contentType: "",
      bytes: 0,
      payload: null,
      meta: { fingerprint },
      createdAt: new Date(now),
    },
  });
  return taken.count === 1 ? { id, lease, fingerprint } : null;
}

function existingOutcome(row: IdempotencyRow, fingerprint: string): IdempotencyOutcome {
  const meta = metaOf(row);
  if (meta.fingerprint !== fingerprint) {
    throw reusedError("Idempotency-Key was already used for a different request; use a new key for a new request");
  }
  if (row.purpose !== DONE) throw inProgressError();
  const mode = meta.replay as IdempotencyReplayMode;
  if (mode !== "body") throw reusedError(`Idempotency-Key was already used: ${UNREPLAYABLE[mode] ?? UNREPLAYABLE.too_large}`);
  return {
    kind: "replay",
    status: typeof meta.status === "number" ? meta.status : 200,
    contentType: row.contentType,
    body: row.payload ?? new Uint8Array(),
  };
}

async function assertRoom(owner: string, now: number): Promise<void> {
  await prisma.storedObject.deleteMany({
    where: { kind: IDEMPOTENCY_KIND, owner, createdAt: { lt: new Date(now - IDEMPOTENCY_TTL_MS) } },
  });
  const live = await prisma.storedObject.count({ where: { kind: IDEMPOTENCY_KIND, owner } });
  if (live >= MAX_IDEMPOTENCY_KEYS) {
    throw new GateError(
      429,
      "rate_limit_exceeded",
      `too many Idempotency-Key values in use: at most ${MAX_IDEMPOTENCY_KEYS} per caller within 24 hours; reuse a key only to retry, or send the request without one`,
      { param: IDEMPOTENCY_HEADER, requestScoped: true },
    );
  }
}

export async function claimIdempotencyKey(
  scope: IdempotencyScope,
  key: string,
  fingerprint: string,
  now = Date.now(),
): Promise<IdempotencyOutcome> {
  const id = idempotencyRowId(scope, key);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const row = await prisma.storedObject.findUnique({ where: { id }, select: ROW_SELECT });
    if (row) {
      if (!abandoned(row, now)) return existingOutcome(row, fingerprint);
      const claim = await takeOver(id, row, fingerprint, now);
      if (claim) return { kind: "claimed", claim };
      continue;
    }
    await assertRoom(scope.owner, now);
    const lease = randomUUID();
    try {
      await prisma.storedObject.create({
        data: {
          id,
          kind: IDEMPOTENCY_KIND,
          owner: scope.owner,
          purpose: PENDING + lease,
          meta: { fingerprint },
          createdAt: new Date(now),
        },
      });
      return { kind: "claimed", claim: { id, lease, fingerprint } };
    } catch (err) {
      if (!isPrismaCode(err, "P2002")) throw err;
    }
  }
  throw inProgressError();
}

export async function completeIdempotencyKey(
  claim: IdempotencyClaim,
  outcome: { status: number; contentType: string; body: Uint8Array | null; replay: IdempotencyReplayMode },
): Promise<boolean> {
  const stored = await prisma.storedObject.updateMany({
    where: { id: claim.id, purpose: PENDING + claim.lease },
    data: {
      purpose: DONE,
      contentType: outcome.contentType,
      bytes: outcome.body?.byteLength ?? 0,
      payload: outcome.body ? new Uint8Array(outcome.body) : null,
      meta: { fingerprint: claim.fingerprint, status: outcome.status, replay: outcome.replay },
      createdAt: new Date(),
    },
  });
  return stored.count === 1;
}

export async function releaseIdempotencyKey(claim: IdempotencyClaim): Promise<void> {
  await prisma.storedObject.deleteMany({ where: { id: claim.id, purpose: PENDING + claim.lease } });
}

async function releaseLogged(claim: IdempotencyClaim): Promise<void> {
  await releaseIdempotencyKey(claim).catch((err) => {
    logger.error("gateway.idempotency_release_failed", { rowId: claim.id, ...errorFields(err) });
  });
}

async function completeLogged(
  claim: IdempotencyClaim,
  outcome: Parameters<typeof completeIdempotencyKey>[1],
): Promise<boolean> {
  return completeIdempotencyKey(claim, outcome).catch((err) => {
    logger.error("gateway.idempotency_store_failed", { rowId: claim.id, ...errorFields(err) });
    return false;
  });
}

function touchClaim(claim: IdempotencyClaim): void {
  void prisma.storedObject
    .updateMany({ where: { id: claim.id, purpose: PENDING + claim.lease }, data: { createdAt: new Date() } })
    .catch((err) => {
      logger.warn("gateway.idempotency_touch_failed", { rowId: claim.id, ...errorFields(err) });
    });
}

function eventStreamOf(response: Response): ReadableStream<Uint8Array> | null {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream") ? response.body : null;
}

function trackStream(
  claim: IdempotencyClaim,
  response: Response,
  source: ReadableStream<Uint8Array>,
  finishedEvents: readonly string[],
): Response {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const window = Math.max(0, ...finishedEvents.map((event) => event.length));
  const contentType = response.headers.get("content-type") ?? "";
  let finished = finishedEvents.length === 0;
  let tail = "";
  let sent = 0;
  let touchedAt = Date.now();
  let settled = false;
  const settle = async (success: boolean) => {
    if (settled) return;
    settled = true;
    const kept = success && (await completeLogged(claim, { status: response.status, contentType, body: null, replay: "stream" }));
    if (!kept) await releaseLogged(claim);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (err) {
          await settle(false);
          controller.error(err);
          return;
        }
        if (read.done) {
          await settle(sent > 0 && finished);
          controller.close();
          return;
        }
        sent += read.value.byteLength;
        if (!finished) {
          const text = tail + decoder.decode(read.value, { stream: true });
          finished = finishedEvents.some((event) => text.includes(event));
          tail = text.slice(-window);
        }
        if (Date.now() - touchedAt >= IDEMPOTENCY_HEARTBEAT_MS) {
          touchedAt = Date.now();
          touchClaim(claim);
        }
        controller.enqueue(read.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        await settle(false);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function replayMode(principal: Principal, bytes: number): IdempotencyReplayMode {
  if (vaultOf(principal.trace)?.size) return "private";
  return bytes > MAX_IDEMPOTENT_BODY_BYTES ? "too_large" : "body";
}

async function runClaimed(
  claim: IdempotencyClaim,
  request: IdempotentRequest,
  run: () => Promise<Response>,
): Promise<Response> {
  let kept = false;
  try {
    const response = await run();
    if (response.status < 200 || response.status >= 300) return response;
    const stream = eventStreamOf(response);
    if (stream) {
      kept = true;
      return trackStream(claim, response, stream, request.finishedEvents ?? []);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const replay = replayMode(request.principal, body.byteLength);
    kept = await completeLogged(claim, {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: replay === "body" ? body : null,
      replay,
    });
    return new Response(bytesBody(body), { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    if (!kept) await releaseLogged(claim);
  }
}

function replayResponse(outcome: Extract<IdempotencyOutcome, { kind: "replay" }>): Response {
  const headers = new Headers({ [IDEMPOTENT_REPLAYED_HEADER]: "true" });
  if (outcome.contentType) headers.set("content-type", outcome.contentType);
  return new Response(bytesBody(outcome.body), { status: outcome.status, headers });
}

export async function idempotent(request: IdempotentRequest, run: () => Promise<Response>): Promise<Response> {
  const key = idempotencyKeyOf(request.req.headers);
  if (key === null) return run();
  const outcome = await claimIdempotencyKey(idempotencyScope(request.req, request.principal), key, request.fingerprint());
  if (outcome.kind === "replay") return replayResponse(outcome);
  return runClaimed(outcome.claim, request, run);
}

export async function purgeIdempotencyKeys(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  let purged = 0;
  for (let chunk = 0; chunk < PURGE_CHUNKS; chunk += 1) {
    const rows = await prisma.storedObject.findMany({
      where: { kind: IDEMPOTENCY_KIND, createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: PURGE_CHUNK,
    });
    if (!rows.length) break;
    const deleted = await prisma.storedObject.deleteMany({
      where: { id: { in: rows.map((row) => row.id) }, kind: IDEMPOTENCY_KIND, createdAt: { lt: cutoff } },
    });
    purged += deleted.count;
    if (rows.length < PURGE_CHUNK) break;
  }
  return purged;
}
