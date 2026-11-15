import "server-only";

import prisma from "@/lib/db/prisma";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { contentSizeBytes, utcDayStart } from "./content-size";
import type { ContentStorage, ContentStoragePolicy } from "@/types/logs";

export const CONTENT_STORAGE_LEASE = "content_storage_lock";
const CONTENT_BACKFILL_BATCH = 25;
const CONTENT_PRUNE_BATCH = 1_000;
const MAINTENANCE_BUDGET_MS = 3_000;
const MAX_BATCHES = 40;

export async function contentStorage(): Promise<ContentStorage> {
  const [measured, pendingRows] = await Promise.all([
    prisma.requestLogContent.aggregate({ _sum: { sizeBytes: true } }),
    prisma.requestLogContent.count({ where: { sizeBytes: null } }),
  ]);
  return { contentBytes: measured._sum.sizeBytes ?? 0, pendingRows };
}

export async function backfillContentSizes(deadline = Date.now() + MAINTENANCE_BUDGET_MS): Promise<number> {
  let measured = 0;
  for (let batch = 0; batch < MAX_BATCHES && Date.now() < deadline; batch += 1) {
    const rows = await prisma.requestLogContent.findMany({
      where: { sizeBytes: null },
      orderBy: [{ createdAt: "asc" }, { logId: "asc" }],
      take: CONTENT_BACKFILL_BATCH,
      select: { logId: true, createdAt: true, request: true, response: true },
    });
    for (const row of rows) {
      if (Date.now() >= deadline) return measured;
      const result = await prisma.requestLogContent.updateMany({
        where: { logId: row.logId, createdAt: row.createdAt, sizeBytes: null },
        data: { sizeBytes: contentSizeBytes(row.request, row.response) },
      });
      measured += result.count;
    }
    if (rows.length < CONTENT_BACKFILL_BATCH) break;
  }
  return measured;
}

async function pruneContentBatch(policy: ContentStoragePolicy): Promise<number> {
  if (!policy.cutoff || policy.maxBytes <= 0) return 0;
  const today = utcDayStart(policy.now);
  const cutoff = policy.cutoff < today ? policy.cutoff : today;
  return prisma.$transaction(async (tx) => {
    if (await tx.requestLogContent.count({ where: { sizeBytes: null } })) return 0;
    const total = await tx.requestLogContent.aggregate({ _sum: { sizeBytes: true } });
    let excess = (total._sum.sizeBytes ?? 0) - policy.maxBytes;
    if (excess <= 0) return 0;
    const rows = await tx.requestLogContent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: [{ createdAt: "asc" }, { logId: "asc" }],
      take: CONTENT_PRUNE_BATCH,
      select: { logId: true, createdAt: true, sizeBytes: true },
    });
    const keys: { logId: string; createdAt: Date }[] = [];
    for (const row of rows) {
      if (excess <= 0) break;
      keys.push({ logId: row.logId, createdAt: row.createdAt });
      excess -= row.sizeBytes ?? 0;
    }
    if (!keys.length) return 0;
    const result = await tx.requestLogContent.deleteMany({
      where: { createdAt: { lt: cutoff }, OR: keys },
    });
    return result.count;
  }, { isolationLevel: "Serializable", timeout: 5_000 });
}

export async function maintainContentStorage(policy: ContentStoragePolicy): Promise<number> {
  const token = await acquireLease(CONTENT_STORAGE_LEASE, 50_000);
  if (!token) return 0;
  try {
    const deadline = Date.now() + MAINTENANCE_BUDGET_MS;
    await backfillContentSizes(deadline);
    let pruned = 0;
    for (let batch = 0; batch < MAX_BATCHES && Date.now() < deadline; batch += 1) {
      const count = await pruneContentBatch(policy);
      pruned += count;
      if (count < CONTENT_PRUNE_BATCH) break;
    }
    return pruned;
  } finally {
    await releaseLease(CONTENT_STORAGE_LEASE, token);
  }
}
