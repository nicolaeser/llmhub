import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backfillContentSizes, contentStorage, maintainContentStorage } from "@/lib/gateway/request-logs/content-storage";
import { contentMaxBytes, contentSizeBytes, utcDayStart } from "@/lib/gateway/request-logs/content-size";
import { contentStoragePolicy, runRetentionSweep } from "@/worker/retention-sweep";
import { normalizeEnterprise } from "@/lib/settings/enterprise";

const now = new Date("2026-12-10T12:00:00Z");
const cutoff = utcDayStart(now);
const old = new Date("2026-12-08T00:00:00Z");

function setup(pendingRows = 0) {
  recordedPrisma.reset({
    setting: { createMany: () => ({ count: 1 }) },
    requestLogContent: {
      aggregate: () => ({ _sum: { sizeBytes: 100 } }),
      count: () => pendingRows,
      findMany: () => [],
    },
  });
}

test("logical bytes count UTF8 JSON, escaping and both payloads independent of object ordering", () => {
  const request = { longer: "ä😀\n", a: [true, 2] };
  const reordered = { a: [true, 2], longer: "ä😀\n" };
  assert.equal(contentSizeBytes(request, { ok: true }), Buffer.byteLength(JSON.stringify(request) + '{"ok":true}'));
  assert.equal(contentSizeBytes(request, null), contentSizeBytes(reordered, undefined));
  assert.equal(contentSizeBytes(null, undefined), 0);
  assert.equal(contentMaxBytes(2), 2 * 1024 ** 3);
  assert.equal(contentMaxBytes(Number.NaN), 0);
});

test("storage reports measured logical bytes and pending rows", async () => {
  setup(3);
  assert.deepEqual(await contentStorage(), { contentBytes: 100, pendingRows: 3 });
});

test("backfill is bounded, updates size only, and matches the composite key", async () => {
  setup();
  recordedPrisma.handlers.requestLogContent.findMany = () => Array.from({ length: 25 }, (_, i) => ({ logId: String(i), createdAt: old, request: { a: "ä" }, response: null }));
  recordedPrisma.handlers.requestLogContent.updateMany = () => ({ count: 1 });
  assert.equal(await backfillContentSizes(), 1_000);
  assert.equal(recordedPrisma.called("requestLogContent", "findMany").length, 40);
  assert.deepEqual(recordedPrisma.called("requestLogContent", "updateMany")[0].args, {
    where: { logId: "0", createdAt: old, sizeBytes: null }, data: { sizeBytes: contentSizeBytes({ a: "ä" }, null) },
  });
  recordedPrisma.calls.length = 0;
  assert.equal(await backfillContentSizes(0), 0);
  assert.equal(recordedPrisma.calls.length, 0);
});

test("pending measurements, disabled cap, archive hold all, and another replica's lease prevent cap deletion", async () => {
  for (const policy of [{ now, cutoff, maxBytes: 1 }, { now, cutoff, maxBytes: 0 }, { now, cutoff: null, maxBytes: 1 }]) {
    setup(1);
    assert.equal(await maintainContentStorage(policy), 0);
    assert.equal(recordedPrisma.called("requestLogContent", "deleteMany").length, 0);
  }
  setup();
  recordedPrisma.handlers.setting.createMany = () => ({ count: 0 });
  assert.equal(await maintainContentStorage({ now, cutoff, maxBytes: 1 }), 0);
  assert.equal(recordedPrisma.called("requestLogContent").length, 0);
});

test("cap deletes only enough oldest content using composite keys and a cutoff no later than today", async () => {
  setup();
  recordedPrisma.handlers.requestLogContent.findMany = (args: { where: { sizeBytes?: null } }) => 'sizeBytes' in args.where ? [] : [
    { logId: "same", createdAt: old, sizeBytes: 60 },
    { logId: "next", createdAt: new Date(old.getTime() + 1), sizeBytes: 30 },
  ];
  recordedPrisma.handlers.requestLogContent.deleteMany = () => ({ count: 1 });
  assert.equal(await maintainContentStorage({ now, cutoff: new Date("2030-01-01"), maxBytes: 50 }), 1);
  assert.deepEqual(recordedPrisma.called("requestLogContent", "deleteMany")[0].args, {
    where: { createdAt: { lt: cutoff }, OR: [{ logId: "same", createdAt: old }] },
  });
  assert.equal(recordedPrisma.called("requestLog").length, 0);
});

test("size policy keeps today and archive-held content, with an explicit null holding everything", () => {
  const enterprise = normalizeEnterprise({ content_max_gb: 2, content_retention_days: 7 });
  assert.deepEqual(contentStoragePolicy(enterprise, now), { now, cutoff, maxBytes: 2 * 1024 ** 3 });
  assert.equal(contentStoragePolicy(enterprise, now, { requestContents: null }).cutoff, null);
  assert.deepEqual(contentStoragePolicy(enterprise, now, { requestContents: old }).cutoff, old);
});

test("age retention uses the composite key and eligible cutoff and explicit null holds stop deletion", async () => {
  setup();
  recordedPrisma.handlers.requestLogContent.findMany = () => [{ logId: "same", createdAt: old }];
  recordedPrisma.handlers.requestLogContent.deleteMany = () => ({ count: 1 });
  const enterprise = normalizeEnterprise({ content_retention_days: 1, log_retention_days: 0, security_retention_days: 0 });
  await runRetentionSweep(enterprise, now, { chunk: 25 });
  assert.deepEqual(recordedPrisma.called("requestLogContent", "deleteMany")[0].args, {
    where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) }, OR: [{ logId: "same", createdAt: old }] },
  });
  setup();
  await runRetentionSweep(enterprise, now, { holds: { requestContents: null, toolExecutions: null } });
  assert.equal(recordedPrisma.called("requestLogContent").length, 0);
});
