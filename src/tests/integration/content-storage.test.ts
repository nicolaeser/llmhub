import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { backfillContentSizes, contentStorage, maintainContentStorage } from "@/lib/gateway/request-logs/content-storage";
import { contentSizeBytes, utcDayStart } from "@/lib/gateway/request-logs/content-size";
import { contentStoragePolicy, runRetentionSweep } from "@/worker/retention-sweep";
import { normalizeEnterprise } from "@/lib/settings/enterprise";
import { closeDatabase, uniqueName } from "./support/database";

after(closeDatabase);

const DAY_MS = 86_400_000;

test("legacy content is measured without payload changes and counts logical UTF8 bytes", async () => {
  const tag = uniqueName("content-storage");
  const first = await prisma.requestLogContent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const at = new Date((first?.createdAt.getTime() ?? Date.now()) - DAY_MS);
  const request = { longKey: "ä😀\n", a: [1, true] };
  const response = { answer: "yes" };
  try {
    const baseline = await contentStorage();
    const log = await prisma.requestLog.create({ data: { tag, contents: { create: { createdAt: at, request, response } } } });
    const before = await prisma.requestLogContent.findUniqueOrThrow({ where: { logId_createdAt: { logId: log.id, createdAt: at } } });
    assert.equal(before.sizeBytes, null);
    assert.equal((await contentStorage()).pendingRows, baseline.pendingRows + 1);
    assert.ok(await backfillContentSizes() >= 1);
    const after = await prisma.requestLogContent.findUniqueOrThrow({ where: { logId_createdAt: { logId: log.id, createdAt: at } } });
    assert.deepEqual(after.request, before.request);
    assert.deepEqual(after.response, before.response);
    assert.equal(after.sizeBytes, contentSizeBytes(request, response));
    assert.ok((await contentStorage()).contentBytes >= baseline.contentBytes + after.sizeBytes!);
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
  }
});

test("cap honors archive holds and deletes only the oldest composite content row while keeping metadata", async (t) => {
  if ((await contentStorage()).pendingRows) return t.skip("Existing unmeasured rows intentionally block size trimming");
  const tag = uniqueName("content-cap");
  const now = new Date();
  const today = utcDayStart(now);
  const first = await prisma.requestLogContent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const old = new Date(Math.min(first?.createdAt.getTime() ?? today.getTime(), today.getTime()) - DAY_MS);
  const hold = new Date(old.getTime() + 1);
  try {
    const log = await prisma.requestLog.create({ data: { tag, contents: { create: [
      { createdAt: old, request: { text: "old" }, sizeBytes: contentSizeBytes({ text: "old" }, null) },
      { createdAt: today, request: { text: "today" }, sizeBytes: contentSizeBytes({ text: "today" }, null) },
      { createdAt: new Date(today.getTime() + DAY_MS), request: { text: "future" }, sizeBytes: contentSizeBytes({ text: "future" }, null) },
    ] } } });
    const total = (await contentStorage()).contentBytes;
    const maxBytes = total - 1;
    const enterprise = normalizeEnterprise({ content_max_gb: 1 });
    const blocked = contentStoragePolicy(enterprise, now, { requestContents: null });
    assert.equal(await maintainContentStorage({ ...blocked, maxBytes }), 0);
    assert.equal(await maintainContentStorage({ now, cutoff: old, maxBytes }), 0);
    const replicas = await Promise.all([
      maintainContentStorage({ now, cutoff: hold, maxBytes }),
      maintainContentStorage({ now, cutoff: hold, maxBytes }),
    ]);
    assert.equal(replicas.reduce((sum, count) => sum + count, 0), 1);
    const contents = await prisma.requestLogContent.findMany({ where: { logId: log.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(contents.map((row) => row.createdAt), [today, new Date(today.getTime() + DAY_MS)]);
    assert.ok(await prisma.requestLog.findUnique({ where: { id: log.id } }));
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
  }
});

test("age retention deletes an expired composite row without deleting a newer row sharing logId", async () => {
  const tag = uniqueName("content-age");
  const first = await prisma.requestLogContent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const old = new Date((first?.createdAt.getTime() ?? Date.now()) - 10 * DAY_MS);
  const now = new Date(old.getTime() + 3 * DAY_MS);
  try {
    const log = await prisma.requestLog.create({ data: { tag, contents: { create: [
      { createdAt: old, request: { text: "old" } },
      { createdAt: now, request: { text: "new" } },
    ] } } });
    const enterprise = normalizeEnterprise({ log_retention_days: 0, content_retention_days: 1, security_retention_days: 0, object_retention_days: 0 });
    await runRetentionSweep(enterprise, now, {
      leaseKey: uniqueName("content-age-lock"),
      holds: { requestLogs: null, toolExecutions: null, securityEvents: null, spendEvents: null, usageRows: null, usageLabelRows: null, auditLogs: null, approvalRequests: null },
    });
    const remaining = await prisma.requestLogContent.findMany({ where: { logId: log.id } });
    assert.deepEqual(remaining.map((row) => row.createdAt), [now]);
    assert.ok(await prisma.requestLog.findUnique({ where: { id: log.id } }));
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
  }
});

test("a bounded maintenance pass leaves unmeasured rows pending and never trims while they remain", async () => {
  const tag = uniqueName("content-pending");
  const now = new Date();
  const first = await prisma.requestLogContent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const old = Math.min(first?.createdAt.getTime() ?? now.getTime(), now.getTime()) - DAY_MS;
  try {
    const log = await prisma.requestLog.create({ data: { tag, contents: { create: Array.from({ length: 1_001 }, (_, index) => ({
      createdAt: new Date(old - index), request: { text: "unmeasured" },
    })) } } });
    assert.equal(await maintainContentStorage({ now, cutoff: utcDayStart(now), maxBytes: 1 }), 0);
    assert.equal(await prisma.requestLogContent.count({ where: { logId: log.id } }), 1_001);
    assert.ok(await prisma.requestLogContent.count({ where: { logId: log.id, sizeBytes: null } }) > 0);
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
  }
});
