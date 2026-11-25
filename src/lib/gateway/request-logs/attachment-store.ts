import "server-only";
import prisma from "@/lib/db/prisma";
import { s3Delete, s3Get, s3Put } from "@/lib/s3/client";
import { objectStorageKey, resolveS3Config } from "@/lib/s3/config";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { ExtractedAttachment } from "@/lib/gateway/request-logs/log-attachments";
import type { SpendScope } from "@/types/structure";

export const ATTACHMENT_KIND = "log-attachment";
export const ORPHAN_GRACE_MS = 60 * 60_000;
const ORPHAN_BATCH = 100;
const ATTACHMENT_ID = /^[0-9a-f]{64}$/;

export async function storeAttachments(files: ExtractedAttachment[]): Promise<number> {
  if (!files.length) return 0;
  const ids = files.map((file) => file.id);
  await prisma.logAttachment.updateMany({ where: { id: { in: ids } }, data: { usedAt: new Date() } });
  const known = await prisma.logAttachment.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const existing = new Set(known.map((row) => row.id));
  const fresh = files.filter((file) => !existing.has(file.id));
  if (!fresh.length) return 0;
  const runtime = await resolveS3Config();
  const rows = [];
  for (const file of fresh) {
    if (runtime) {
      const key = objectStorageKey(ATTACHMENT_KIND, file.id);
      await s3Put(runtime, key, file.payload, file.contentType);
      rows.push({ id: file.id, contentType: file.contentType, bytes: file.payload.byteLength, storageKey: key });
    } else {
      rows.push({
        id: file.id,
        contentType: file.contentType,
        bytes: file.payload.byteLength,
        payload: new Uint8Array(file.payload),
      });
    }
  }
  const { count } = await prisma.logAttachment.createMany({ data: rows, skipDuplicates: true });
  return count ? fresh.reduce((sum, file) => sum + file.payload.byteLength, 0) : 0;
}

export async function readAttachment(
  scope: SpendScope,
  id: string,
): Promise<{ contentType: string; payload: Uint8Array } | null> {
  if (!ATTACHMENT_ID.test(id)) return null;
  const ref = await prisma.requestLogAttachment.findFirst({
    where: { attachmentId: id, content: { log: { ...scope } } },
    select: { attachmentId: true },
  });
  if (!ref) return null;
  const row = await prisma.logAttachment.findUnique({ where: { id } });
  if (!row) return null;
  if (row.payload) return { contentType: row.contentType, payload: row.payload };
  if (!row.storageKey) return null;
  const runtime = await resolveS3Config();
  if (!runtime) return null;
  const got = await s3Get(runtime, row.storageKey);
  return { contentType: row.contentType, payload: got.body };
}

export async function pruneOrphanAttachments(now = new Date()): Promise<number> {
  const unused = { refs: { none: {} }, usedAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) } };
  const rows = await prisma.logAttachment.findMany({
    where: unused,
    orderBy: { usedAt: "asc" },
    take: ORPHAN_BATCH,
    select: { id: true, storageKey: true },
  });
  if (!rows.length) return 0;
  const runtime = rows.some((row) => row.storageKey) ? await resolveS3Config() : null;
  let removed = 0;
  for (const row of rows) {
    const { count } = await prisma.logAttachment.deleteMany({ where: { id: row.id, ...unused } });
    if (!count) continue;
    removed += count;
    if (!row.storageKey || !runtime) continue;
    try {
      await s3Delete(runtime, row.storageKey);
    } catch (err) {
      logger.warn("logs.attachment_delete_failed", { attachmentId: row.id, ...errorFields(err) });
    }
  }
  return removed;
}
