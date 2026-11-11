import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import prisma from "@/lib/db/prisma";
import {
  contentPartitionName,
  contentStorage,
  createContentPartition,
  defaultPartitionDays,
  dropContentPartition,
  expiredContentPartitions,
  listContentPartitions,
  maintainContentPartitions,
  missingContentDays,
  utcDayStart,
} from "@/lib/db/content-partitions";
import { logMaintenanceSweep, runMaintenanceSweep } from "@/worker/jobs";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting } from "./support/fixtures";

after(closeDatabase);

const DAY_MS = 86_400_000;
const FAR = new Date("2100-01-01T00:00:00.000Z");
const PAYLOAD = Array.from({ length: 40 }, (_, index) => `${index}-${Math.random().toString(36).repeat(60)}`);

function farDay(offset: number): Date {
  return new Date(FAR.getTime() + offset * DAY_MS);
}

async function logWithContent(tag: string, at: Date) {
  return prisma.requestLog.create({
    data: { tag, createdAt: at, contents: { create: { request: { tag, payload: PAYLOAD }, createdAt: at } } },
  });
}

async function contentCount(tag: string): Promise<number> {
  return prisma.requestLogContent.count({ where: { log: { tag } } });
}

async function dropFarPartitions() {
  for (const partition of await listContentPartitions()) {
    if (partition.name.startsWith("RequestLogContent_p2100")) await dropContentPartition(partition);
  }
}

test("the content table is partitioned by day with a partition for older rows and a default", async () => {
  const partitions = await listContentPartitions();
  const names = partitions.map((partition) => partition.name);
  assert.ok(names.includes("RequestLogContent_default"));
  const today = utcDayStart(new Date()).getTime();
  const covered = partitions.some(
    (partition) => partition.to !== null && (partition.from === null || partition.from.getTime() <= today) && today < partition.to.getTime(),
  );
  assert.equal(covered || names.includes("RequestLogContent_default"), true);
  const storage = await contentStorage();
  assert.ok(storage.databaseBytes > storage.contentBytes);
  assert.ok(storage.contentBytes > 0 && storage.logBytes > 0);
});

test("partition upkeep creates the coming days once and drops nothing without a limit", async () => {
  const now = new Date();
  assert.equal(await maintainContentPartitions({ now, cutoff: null, maxBytes: 0 }), 0);
  const partitions = await listContentPartitions();
  assert.deepEqual(missingContentDays(partitions, now), []);
  const before = partitions.map((partition) => partition.name);
  assert.equal(await maintainContentPartitions({ now, cutoff: null, maxBytes: 0 }), 0);
  assert.deepEqual((await listContentPartitions()).map((partition) => partition.name), before);
});

test("expired days are dropped as whole partitions and return their space, newer days and the logs stay", async () => {
  const tag = uniqueName("partition");
  try {
    for (const offset of [0, 1, 2, 3]) assert.equal(await createContentPartition(farDay(offset)), true);
    assert.equal(await createContentPartition(farDay(0)), true);
    for (const offset of [0, 1, 2, 3]) {
      await logWithContent(tag, new Date(farDay(offset).getTime() + 3_600_000));
      await logWithContent(tag, new Date(farDay(offset).getTime() + 7_200_000));
    }
    const far = (await listContentPartitions()).filter((partition) => partition.name.startsWith("RequestLogContent_p2100"));
    assert.deepEqual(
      far.map((partition) => partition.name),
      [0, 1, 2, 3].map((offset) => contentPartitionName(farDay(offset))),
    );
    assert.ok(far.every((partition) => partition.bytes > 30_000));

    const byTime = expiredContentPartitions(far, { now: farDay(3), cutoff: new Date(farDay(2).getTime() - 1), maxBytes: 0 });
    assert.deepEqual(byTime.map((partition) => partition.name), [contentPartitionName(farDay(0))]);
    const exact = expiredContentPartitions(far, { now: farDay(3), cutoff: farDay(2), maxBytes: 0 });
    assert.deepEqual(exact.map((partition) => partition.name), [0, 1].map((offset) => contentPartitionName(farDay(offset))));

    const before = (await contentStorage()).contentBytes;
    for (const partition of exact) assert.equal(await dropContentPartition(partition), true);
    assert.equal(await contentCount(tag), 4);
    assert.equal(await prisma.requestLog.count({ where: { tag } }), 8);
    assert.ok((await contentStorage()).contentBytes <= before - exact.reduce((sum, partition) => sum + partition.bytes, 0) + 8_192);

    const rest = (await listContentPartitions()).filter((partition) => partition.name.startsWith("RequestLogContent_p2100"));
    const total = rest.reduce((sum, partition) => sum + partition.bytes, 0);
    const capped = expiredContentPartitions(rest, { now: farDay(3), cutoff: null, maxBytes: total - 1 });
    assert.deepEqual(capped.map((partition) => partition.name), [contentPartitionName(farDay(2))]);
    const tiny = expiredContentPartitions(rest, { now: farDay(3), cutoff: null, maxBytes: 1 });
    assert.deepEqual(tiny.map((partition) => partition.name), [contentPartitionName(farDay(2))]);
    assert.equal(await dropContentPartition({ name: "RequestLog", from: null, to: farDay(1), bytes: 0 }), false);
    assert.equal(await dropContentPartition({ name: "RequestLogContent_default", from: null, to: null, bytes: 0 }), false);
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
    await dropFarPartitions();
  }
});

test("a row without a day partition lands in the default partition instead of failing the log write", async () => {
  const tag = uniqueName("partition");
  try {
    const log = await logWithContent(tag, new Date("2150-06-01T12:00:00.000Z"));
    assert.equal(await contentCount(tag), 1);
    const found = await prisma.requestLog.findUnique({ where: { id: log.id }, include: { contents: { take: 1 } } });
    assert.equal(found?.contents.length, 1);
    const held = await defaultPartitionDays();
    assert.ok(held.some((day) => day.toISOString() === "2150-06-01T00:00:00.000Z"));
    const partitions = await listContentPartitions();
    assert.deepEqual(missingContentDays(partitions, new Date("2150-06-01T08:00:00.000Z"), 0, held), []);
    assert.equal(missingContentDays(partitions, new Date("2150-06-01T08:00:00.000Z"), 0).length, 1);
  } finally {
    await prisma.requestLog.deleteMany({ where: { tag } });
  }
});

test("the sweep the worker runs removes content after the saved number of days, keeps the log, and deletes logs after theirs", async () => {
  const tag = uniqueName("worker-retention");
  const restore = await preserveSetting("enterprise");
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const offline = mock.method(globalThis, "fetch", async () => {
    throw new Error("tests stay offline");
  });
  try {
    await prisma.setting.upsert({
      where: { key: "enterprise" },
      update: { value: JSON.stringify({ log_retention_days: 30, content_retention_days: 7 }) },
      create: { key: "enterprise", value: JSON.stringify({ log_retention_days: 30, content_retention_days: 7 }) },
    });
    const expiredLog = await logWithContent(tag, ago(31));
    const expiredContent = await logWithContent(tag, ago(8));
    const fresh = await logWithContent(tag, ago(6));
    const result = await runMaintenanceSweep(now);
    logMaintenanceSweep(result);
    assert.ok(result.requestContents >= 1);
    assert.ok(result.requestLogs >= 1);
    assert.equal(result.retentionBacklog, 0);
    const rows = await prisma.requestLog.findMany({ where: { tag }, include: { contents: { select: { logId: true } } } });
    assert.deepEqual(
      rows.map((row) => [row.id, row.contents.length]).sort(),
      [
        [expiredContent.id, 0],
        [fresh.id, 1],
      ].sort(),
    );
    assert.equal(rows.some((row) => row.id === expiredLog.id), false);

    await prisma.setting.update({
      where: { key: "enterprise" },
      data: { value: JSON.stringify({ log_retention_days: 0, content_retention_days: 0 }) },
    });
    const kept = await logWithContent(tag, ago(400));
    const unlimited = await runMaintenanceSweep(now);
    assert.deepEqual([unlimited.requestContents, unlimited.requestLogs], [0, 0]);
    assert.equal(await prisma.requestLogContent.count({ where: { logId: kept.id } }), 1);
  } finally {
    offline.mock.restore();
    await prisma.requestLog.deleteMany({ where: { tag } });
    await restore();
  }
});
