import "server-only";
import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { asRecord, asStringMap, newId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { deleteObject } from "@/lib/gateway/objects";
import { keyPrincipal, sessionPrincipal } from "@/lib/gateway/principal";
import { getEnterprise, normalizeVectorDefaults } from "@/lib/gateway/settings";
import { chunkingJson } from "@/lib/rag/chunking";
import { attributesOf } from "@/lib/rag/filters";
import { evictFiles, evictStore } from "@/lib/rag/index-cache";
import { ownsStore, readableStores, readsStore, scopeOf } from "@/lib/rag/scope";
import type { JsonMap, Principal } from "@/types/gateway";
import type {
  Attributes,
  ChunkSettings,
  FileCounts,
  IngestSnapshot,
  ListQuery,
  StoreUsage,
  VectorFileError,
  VectorFileStatus,
  VectorStoreDefaults,
  VectorStoreOwner,
  VectorStoreStatus,
} from "@/types/rag";

export const STORE_PREFIX = "vs_";
export const BATCH_PREFIX = "vsfb_";
export const MAX_STORE_FILES = 10_000;
const DAY_MS = 86_400_000;
const FILE_STATUSES = ["in_progress", "completed", "failed", "cancelled"] as const;

export type StoreRow = Prisma.VectorStoreGetPayload<object>;
export type StoreFileRow = Prisma.VectorStoreFileGetPayload<object>;

export function unixSeconds(date: Date | null | undefined): number | null {
  return date ? Math.floor(date.getTime() / 1000) : null;
}

export async function vectorDefaults(): Promise<VectorStoreDefaults> {
  return (await getEnterprise()).vector_stores ?? normalizeVectorDefaults({});
}

export function emptyCounts(): FileCounts {
  return { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
}

export async function storeUsage(ids: string[]): Promise<Map<string, StoreUsage>> {
  const out = new Map<string, StoreUsage>(ids.map((id) => [id, { counts: emptyCounts(), usageBytes: 0 }]));
  if (!ids.length) return out;
  const rows = await prisma.vectorStoreFile.groupBy({
    by: ["storeId", "status"],
    where: { storeId: { in: ids } },
    _count: { _all: true },
    _sum: { usageBytes: true },
  });
  for (const row of rows) {
    const usage = out.get(row.storeId);
    if (!usage) continue;
    const status = row.status as VectorFileStatus;
    if (FILE_STATUSES.includes(status)) usage.counts[status] += row._count._all;
    usage.counts.total += row._count._all;
    usage.usageBytes += row._sum.usageBytes ?? 0;
  }
  return out;
}

export function storeStatus(row: Pick<StoreRow, "expiresAt">, counts: FileCounts, now = new Date()): VectorStoreStatus {
  if (row.expiresAt && row.expiresAt <= now) return "expired";
  return counts.in_progress > 0 ? "in_progress" : "completed";
}

export function expiresAtOf(days: number | null | undefined, from: Date): Date | null {
  return days ? new Date(from.getTime() + days * DAY_MS) : null;
}

export function storeJson(row: StoreRow, usage: StoreUsage | undefined): JsonMap {
  const counts = usage?.counts ?? emptyCounts();
  return {
    id: row.id,
    object: "vector_store",
    created_at: unixSeconds(row.createdAt),
    name: row.name,
    description: row.description || null,
    usage_bytes: usage?.usageBytes ?? 0,
    file_counts: counts,
    status: storeStatus(row, counts),
    expires_after: row.expiresAfterDays ? { anchor: "last_active_at", days: row.expiresAfterDays } : null,
    expires_at: unixSeconds(row.expiresAt),
    last_active_at: unixSeconds(row.lastActiveAt),
    metadata: asStringMap(row.metadata),
    scope: scopeOf(row),
    embedding_model: row.embeddingModel,
    embedding_dimensions: row.dimensions || row.embeddingDimensions || null,
    rerank_model: row.rerankModel || null,
    ocr_model: row.ocrModel || null,
    chunking_strategy: chunkingJson({ maxTokens: row.chunkMaxTokens, overlapTokens: row.chunkOverlapTokens }),
  };
}

export async function storesJson(rows: StoreRow[]): Promise<JsonMap[]> {
  const usage = await storeUsage(rows.map((row) => row.id));
  return rows.map((row) => storeJson(row, usage.get(row.id)));
}

export function fileError(value: unknown): VectorFileError | null {
  const rec = asRecord(value);
  if (!rec || typeof rec.code !== "string") return null;
  return { code: rec.code as VectorFileError["code"], message: typeof rec.message === "string" ? rec.message : "" };
}

export function fileJson(row: StoreFileRow): JsonMap {
  return {
    id: row.fileId,
    object: "vector_store.file",
    usage_bytes: row.usageBytes,
    created_at: unixSeconds(row.createdAt),
    vector_store_id: row.storeId,
    status: row.status,
    last_error: fileError(row.lastError),
    chunking_strategy: chunkingJson({ maxTokens: row.chunkMaxTokens, overlapTokens: row.chunkOverlapTokens }),
    attributes: attributesOf(row.attributes),
  };
}

function notFound(id: string): GateError {
  return new GateError(404, "not_found", `vector store ${id} not found`, { param: "vector_store_id" });
}

export async function readableStore(principal: Principal, id: string): Promise<StoreRow> {
  const row = await prisma.vectorStore.findUnique({ where: { id } });
  if (!row || !readsStore(principal, row)) throw notFound(id);
  return row;
}

export async function writableStore(principal: Principal, id: string): Promise<StoreRow> {
  const row = await readableStore(principal, id);
  if (!ownsStore(principal, row)) {
    throw new GateError(403, "permission_denied", "company vector stores are read-only for API keys; manage them in the console");
  }
  return row;
}

export function usableStore(row: StoreRow): StoreRow {
  if (row.expiresAt && row.expiresAt <= new Date()) {
    throw new GateError(400, "invalid_request", `vector store ${row.id} has expired`, { param: "vector_store_id" });
  }
  return row;
}

export async function createVectorStore(input: {
  owner: VectorStoreOwner;
  createdBy: string;
  name: string;
  description: string;
  embeddingModel: string;
  embeddingDimensions: number;
  rerankModel: string;
  ocrModel: string;
  chunk: Pick<ChunkSettings, "maxTokens" | "overlapTokens">;
  metadata: Record<string, string>;
  expiresAfterDays: number | null;
}): Promise<StoreRow> {
  const now = new Date();
  return prisma.vectorStore.create({
    data: {
      id: `${STORE_PREFIX}${newId(12)}`,
      ...input.owner,
      createdBy: input.createdBy,
      name: input.name,
      description: input.description,
      embeddingModel: input.embeddingModel,
      embeddingDimensions: input.embeddingDimensions,
      rerankModel: input.rerankModel,
      ocrModel: input.ocrModel,
      chunkMaxTokens: input.chunk.maxTokens,
      chunkOverlapTokens: input.chunk.overlapTokens,
      metadata: input.metadata,
      expiresAfterDays: input.expiresAfterDays,
      expiresAt: expiresAtOf(input.expiresAfterDays, now),
      lastActiveAt: now,
    },
  });
}

export async function updateVectorStore(
  row: StoreRow,
  patch: {
    name?: string;
    description?: string;
    metadata?: Record<string, string>;
    expiresAfterDays?: number | null;
    rerankModel?: string;
    ocrModel?: string;
  },
): Promise<StoreRow> {
  const data: Prisma.VectorStoreUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.metadata !== undefined) data.metadata = patch.metadata;
  if (patch.rerankModel !== undefined) data.rerankModel = patch.rerankModel;
  if (patch.ocrModel !== undefined) data.ocrModel = patch.ocrModel;
  if (patch.expiresAfterDays !== undefined) {
    data.expiresAfterDays = patch.expiresAfterDays;
    data.expiresAt = expiresAtOf(patch.expiresAfterDays, row.lastActiveAt);
  }
  return prisma.vectorStore.update({ where: { id: row.id }, data });
}

export async function deleteVectorStore(id: string): Promise<boolean> {
  const deleted = await prisma.vectorStore.deleteMany({ where: { id } });
  evictStore(id);
  return deleted.count > 0;
}

export async function touchStores(rows: Pick<StoreRow, "id" | "expiresAfterDays">[]): Promise<void> {
  const now = new Date();
  await Promise.all(
    rows.map((row) =>
      prisma.vectorStore.updateMany({
        where: { id: row.id },
        data: { lastActiveAt: now, expiresAt: expiresAtOf(row.expiresAfterDays, now) },
      }),
    ),
  );
}

export function listQuery(url: URL): ListQuery {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 20));
  return {
    limit,
    order: url.searchParams.get("order") === "asc" ? "asc" : "desc",
    after: url.searchParams.get("after") || null,
    before: url.searchParams.get("before") || null,
  };
}

function listPage(data: JsonMap[], hasMore: boolean): JsonMap {
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: hasMore,
  };
}

function flip(order: "asc" | "desc"): "asc" | "desc" {
  return order === "asc" ? "desc" : "asc";
}

export async function listStores(principal: Principal, query: ListQuery): Promise<JsonMap> {
  const backwards = Boolean(query.before && !query.after);
  const order = backwards ? flip(query.order) : query.order;
  const cursor = query.after ?? query.before;
  const rows = await prisma.vectorStore.findMany({
    where: readableStores(principal),
    orderBy: [{ createdAt: order }, { id: order }],
    take: query.limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  if (backwards) page.reverse();
  return listPage(await storesJson(page), rows.length > query.limit);
}

export async function listStoreFiles(
  storeId: string,
  query: ListQuery & { status: string | null; batchId?: string },
): Promise<JsonMap> {
  const backwards = Boolean(query.before && !query.after);
  const order = backwards ? flip(query.order) : query.order;
  const cursor = query.after ?? query.before;
  const rows = await prisma.vectorStoreFile.findMany({
    where: {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
    },
    orderBy: [{ createdAt: order }, { fileId: order }],
    take: query.limit + 1,
    ...(cursor ? { cursor: { storeId_fileId: { storeId, fileId: cursor } }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  if (backwards) page.reverse();
  return listPage(page.map(fileJson), rows.length > query.limit);
}

export function ingestSnapshot(principal: Principal): IngestSnapshot {
  if (principal.key?.token_id) return { kind: "key", keyId: principal.key.token_id };
  return { kind: "user", userId: principal.userId, orgId: principal.orgId, actor: principal.actor };
}

export async function ingestPrincipal(raw: unknown): Promise<Principal | null> {
  const snap = asRecord(raw);
  if (snap?.kind === "key" && typeof snap.keyId === "string") return keyPrincipal(snap.keyId);
  if (snap?.kind !== "user" || typeof snap.userId !== "string" || !snap.userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: snap.userId },
    select: { id: true, orgId: true, blocked: true },
  });
  if (!user || user.blocked) return null;
  const orgId = typeof snap.orgId === "string" && snap.orgId ? snap.orgId : (user.orgId ?? "");
  return { ...sessionPrincipal(user), orgId };
}

export type AttachRequest = {
  fileId: string;
  chunk: ChunkSettings;
  attributes: Attributes;
};

const CONSOLE_OWNER = "vector-store:";
const ORPHAN_GRACE_MS = 60 * 60_000;

export function consoleFileOwner(storeId: string): string {
  return `${CONSOLE_OWNER}${storeId}`;
}

export async function purgeOrphanUploads(now = new Date()): Promise<number> {
  const rows = await prisma.storedObject.findMany({
    where: {
      kind: "file",
      owner: { startsWith: CONSOLE_OWNER },
      createdAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
      vectorFiles: { none: {} },
    },
    select: { id: true },
    take: 200,
  });
  let purged = 0;
  for (const row of rows) if (await deleteObject(row.id, "")) purged += 1;
  return purged;
}

async function readableFiles(owner: string, ids: string[]): Promise<Map<string, string>> {
  const rows = await prisma.storedObject.findMany({
    where: { id: { in: ids }, kind: "file", owner: { in: [owner, ""] } },
    select: { id: true, filename: true },
  });
  return new Map(rows.map((row) => [row.id, row.filename]));
}

export async function attachFiles(input: {
  store: StoreRow;
  fileOwner: string;
  snapshot: IngestSnapshot;
  files: AttachRequest[];
  batchId: string;
}): Promise<StoreFileRow[]> {
  const ids = [...new Set(input.files.map((file) => file.fileId))];
  if (!ids.length) return [];
  const names = await readableFiles(input.fileOwner, ids);
  const missing = ids.find((id) => !names.has(id));
  if (missing) throw new GateError(404, "not_found", `file ${missing} not found`, { param: "file_id" });
  const existing = await prisma.vectorStoreFile.count({
    where: { storeId: input.store.id, fileId: { notIn: ids } },
  });
  if (existing + ids.length > MAX_STORE_FILES) {
    throw new GateError(400, "invalid_request", `a vector store holds at most ${MAX_STORE_FILES} files`, {
      param: "file_ids",
    });
  }
  const seen = new Set<string>();
  const rows: StoreFileRow[] = [];
  for (const file of input.files) {
    if (seen.has(file.fileId)) continue;
    seen.add(file.fileId);
    const data = {
      batchId: input.batchId,
      status: "in_progress",
      filename: names.get(file.fileId) ?? "",
      attributes: file.attributes,
      chunkingType: file.chunk.type,
      chunkMaxTokens: file.chunk.maxTokens,
      chunkOverlapTokens: file.chunk.overlapTokens,
      usageBytes: 0,
      chunkCount: 0,
      lastError: Prisma.DbNull,
      ingestBy: input.snapshot,
      attempts: 0,
      leaseUntil: null,
      indexedAt: null,
    };
    rows.push(
      await prisma.vectorStoreFile.upsert({
        where: { storeId_fileId: { storeId: input.store.id, fileId: file.fileId } },
        create: { storeId: input.store.id, fileId: file.fileId, ...data },
        update: data,
      }),
    );
  }
  evictFiles(input.store.id, ids);
  return rows;
}

export async function storeFile(storeId: string, fileId: string): Promise<StoreFileRow> {
  const row = await prisma.vectorStoreFile.findUnique({ where: { storeId_fileId: { storeId, fileId } } });
  if (!row) throw new GateError(404, "not_found", `file ${fileId} is not in vector store ${storeId}`, { param: "file_id" });
  return row;
}

export async function updateFileAttributes(row: StoreFileRow, attributes: Attributes): Promise<StoreFileRow> {
  return prisma.vectorStoreFile.update({
    where: { storeId_fileId: { storeId: row.storeId, fileId: row.fileId } },
    data: { attributes },
  });
}

export async function detachFile(storeId: string, fileId: string): Promise<boolean> {
  const deleted = await prisma.vectorStoreFile.deleteMany({ where: { storeId, fileId } });
  evictFiles(storeId, [fileId]);
  return deleted.count > 0;
}

export async function fileChunksJson(row: StoreFileRow): Promise<JsonMap> {
  const chunks = await prisma.vectorChunk.findMany({
    where: { storeId: row.storeId, fileId: row.fileId },
    orderBy: { position: "asc" },
    select: { text: true },
  });
  return {
    object: "vector_store.file_content.page",
    data: chunks.map((chunk) => ({ type: "text", text: chunk.text })),
    has_more: false,
    next_page: null,
  };
}

export function newBatchId(): string {
  return `${BATCH_PREFIX}${newId(12)}`;
}

export async function batchJson(storeId: string, batchId: string): Promise<JsonMap> {
  const rows = await prisma.vectorStoreFile.groupBy({
    by: ["status"],
    where: { storeId, batchId },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  if (!batchId || !rows.length) {
    throw new GateError(404, "not_found", `file batch ${batchId} not found`, { param: "batch_id" });
  }
  const counts = emptyCounts();
  let createdAt: Date | null = null;
  for (const row of rows) {
    const status = row.status as VectorFileStatus;
    if (FILE_STATUSES.includes(status)) counts[status] += row._count._all;
    counts.total += row._count._all;
    const first = row._min.createdAt;
    if (first && (!createdAt || first < createdAt)) createdAt = first;
  }
  const status =
    counts.in_progress > 0
      ? "in_progress"
      : counts.cancelled > 0
        ? "cancelled"
        : counts.failed === counts.total
          ? "failed"
          : "completed";
  return {
    id: batchId,
    object: "vector_store.file_batch",
    created_at: unixSeconds(createdAt),
    vector_store_id: storeId,
    status,
    file_counts: counts,
  };
}

export async function cancelBatch(storeId: string, batchId: string): Promise<void> {
  await prisma.vectorStoreFile.updateMany({
    where: { storeId, batchId, status: "in_progress" },
    data: { status: "cancelled", leaseUntil: null },
  });
}

export async function expireVectorStores(now = new Date()): Promise<number> {
  const rows = await prisma.vectorStore.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true },
    take: 100,
  });
  let removed = 0;
  for (const row of rows) if (await deleteVectorStore(row.id)) removed += 1;
  return removed;
}
