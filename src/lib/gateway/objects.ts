import "server-only";
import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { BATCH_QUEUED, BATCH_RESULT_PURPOSE, BATCH_RUNNING } from "@/lib/gateway/batch-format";
import { ownerId } from "@/lib/gateway/core";
import { objectStorageKey, resolveS3Config } from "@/lib/s3/config";
import { s3Delete, s3Get, s3PublicUrl, s3Put } from "@/lib/s3/client";
import type { Stored, StorageMeta, Principal } from "@/types/gateway";
import type { S3Runtime } from "@/types/s3";

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function storageOf(meta: Record<string, unknown>): StorageMeta | null {
  const rec = asMeta(meta.storage);
  if (rec.backend !== "s3" || typeof rec.key !== "string" || !rec.key) return null;
  return {
    backend: "s3",
    key: rec.key,
    url: typeof rec.url === "string" ? rec.url : undefined,
  };
}

function toStored(row: {
  id: string;
  kind: string;
  owner: string;
  filename: string;
  purpose: string;
  contentType: string;
  bytes: number;
  payload: Uint8Array | null;
  meta: unknown;
  createdAt: Date;
}): Stored {
  return {
    id: row.id,
    kind: row.kind,
    owner: row.owner,
    filename: row.filename,
    purpose: row.purpose,
    contentType: row.contentType,
    bytes: row.bytes,
    payload: row.payload ?? new Uint8Array(),
    meta: asMeta(row.meta),
    createdAt: row.createdAt,
  };
}

async function loadPayload(stored: Stored, runtime: S3Runtime | null): Promise<Stored> {
  const storage = storageOf(stored.meta);
  if (!storage || stored.payload.byteLength) return stored;
  if (!runtime) return stored;
  const got = await s3Get(runtime, storage.key);
  return {
    ...stored,
    payload: got.body,
    contentType: stored.contentType || got.contentType,
  };
}

export async function putObject(input: {
  kind: string;
  owner: string;
  filename?: string;
  purpose?: string;
  contentType?: string;
  payload: Uint8Array | Buffer;
  meta?: Record<string, unknown>;
}): Promise<Stored> {
  const payload = Buffer.from(input.payload);
  const runtime = await resolveS3Config();
  const meta = { ...(input.meta ?? {}) };
  let dbPayload: Buffer | null = payload;
  if (runtime) {
    const rowId = crypto.randomUUID();
    const key = objectStorageKey(
      input.kind,
      rowId,
      input.filename || "blob",
    );
    await s3Put(runtime, key, payload, input.contentType || "application/octet-stream");
    meta.storage = {
      backend: "s3",
      key,
      url: s3PublicUrl(runtime, key),
    } satisfies StorageMeta;
    dbPayload = null;
    const row = await prisma.storedObject.create({
      data: {
        id: rowId,
        kind: input.kind,
        owner: input.owner,
        filename: input.filename ?? "",
        purpose: input.purpose ?? "",
        contentType: input.contentType ?? "",
        bytes: payload.byteLength,
        payload: dbPayload,
        meta: meta as Prisma.InputJsonValue,
      },
    });
    return { ...toStored(row), payload };
  }
  const row = await prisma.storedObject.create({
    data: {
      kind: input.kind,
      owner: input.owner,
      filename: input.filename ?? "",
      purpose: input.purpose ?? "",
      contentType: input.contentType ?? "",
      bytes: payload.byteLength,
      payload: dbPayload ? new Uint8Array(dbPayload) : null,
      meta: meta as Prisma.InputJsonValue,
    },
  });
  return toStored(row);
}

export async function getObject(id: string): Promise<Stored | null> {
  const row = await prisma.storedObject.findUnique({ where: { id } });
  if (!row) return null;
  const stored = toStored(row);
  return loadPayload(stored, await resolveS3Config());
}

export async function listObjects(kind: string, owner: string): Promise<Stored[]> {
  const rows = await prisma.storedObject.findMany({
    where: owner ? { kind, owner } : { kind },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(toStored);
}

export async function updateObjectPayload(
  id: string,
  payload: Uint8Array | Buffer,
  meta?: Record<string, unknown>,
): Promise<void> {
  const buf = Buffer.from(payload);
  const existing = await prisma.storedObject.findUnique({ where: { id } });
  if (!existing) return;
  const currentMeta = { ...asMeta(existing.meta), ...(meta ?? {}) };
  const runtime = await resolveS3Config();
  const storage = storageOf(currentMeta);
  if (runtime) {
    const key =
      storage?.key ||
      objectStorageKey(existing.kind, id, existing.filename || "blob");
    await s3Put(runtime, key, buf, existing.contentType || "application/octet-stream");
    currentMeta.storage = {
      backend: "s3",
      key,
      url: s3PublicUrl(runtime, key),
    } satisfies StorageMeta;
    await prisma.storedObject.update({
      where: { id },
      data: {
        payload: null,
        bytes: buf.byteLength,
        meta: currentMeta as Prisma.InputJsonValue,
      },
    });
    return;
  }
  await prisma.storedObject.update({
    where: { id },
    data: {
      payload: new Uint8Array(buf),
      bytes: buf.byteLength,
      meta: currentMeta as Prisma.InputJsonValue,
    },
  });
}

export async function deleteObject(id: string, owner: string): Promise<boolean> {
  const row = await prisma.storedObject.findUnique({ where: { id } });
  if (!row) return false;
  if (owner && row.owner !== owner) return false;
  const storage = storageOf(asMeta(row.meta));
  if (storage) {
    const runtime = await resolveS3Config();
    if (runtime) await s3Delete(runtime, storage.key).catch(() => undefined);
  }
  await prisma.storedObject.delete({ where: { id } });
  return true;
}

export function canReadObject(object: Stored, principal: Principal): boolean {
  const owner = ownerId(principal);
  return object.owner === owner || object.owner === "";
}

export function fileJson(object: Stored) {
  const storage = storageOf(object.meta);
  return {
    id: object.id,
    object: "file",
    bytes: object.bytes,
    created_at: Math.floor(object.createdAt.getTime() / 1000),
    filename: object.filename,
    purpose: object.purpose,
    url: storage?.url,
  };
}

export function payloadJson(object: Stored): unknown {
  try {
    return JSON.parse(Buffer.from(object.payload).toString("utf8"));
  } catch {
    return {};
  }
}

const PURGE_LIMIT = 500;

export async function purgeStoredObjects(input: {
  generatedBefore: Date | null;
  uploadsBefore: Date | null;
}): Promise<number> {
  const where: Prisma.StoredObjectWhereInput[] = [];
  if (input.generatedBefore) {
    const createdAt = { lt: input.generatedBefore };
    where.push(
      { kind: { in: ["response", "video"] }, createdAt },
      {
        kind: "batch",
        createdAt,
        NOT: [{ purpose: BATCH_QUEUED }, { purpose: { startsWith: BATCH_RUNNING } }],
      },
      { kind: "file", purpose: BATCH_RESULT_PURPOSE, createdAt },
    );
  }
  if (input.uploadsBefore) {
    where.push({ kind: "file", purpose: { not: BATCH_RESULT_PURPOSE }, createdAt: { lt: input.uploadsBefore } });
  }
  if (!where.length) return 0;
  const rows = await prisma.storedObject.findMany({
    where: { OR: where },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: PURGE_LIMIT,
  });
  let purged = 0;
  for (const row of rows) {
    if (await deleteObject(row.id, "")) purged += 1;
  }
  return purged;
}
