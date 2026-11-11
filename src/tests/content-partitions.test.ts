import assert from "node:assert/strict";
import test from "node:test";
import {
  contentMaxBytes,
  contentPartitionName,
  contentPartitionOf,
  expiredContentPartitions,
  missingContentDays,
} from "@/lib/db/content-partitions";
import { normalizeEnterprise } from "@/lib/settings/enterprise";
import { clampContentMaxGb } from "@/lib/settings/retention-defaults";
import { contentPartitionPolicy } from "@/worker/retention-sweep";
import type { ContentPartition } from "@/types/logs";

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
const NOW = new Date("2026-12-10T15:30:00.000Z");

function day(offset: number): Date {
  return new Date(Date.UTC(2026, 11, 10) + offset * DAY_MS);
}

function daily(offset: number, bytes = GIB): ContentPartition {
  return { name: contentPartitionName(day(offset)), from: day(offset), to: day(offset + 1), bytes };
}

const LEGACY: ContentPartition = { name: "RequestLogContent_legacy", from: null, to: day(-20), bytes: 40 * GIB };
const DEFAULT: ContentPartition = { name: "RequestLogContent_default", from: null, to: null, bytes: 8_192 };

test("partition bounds from Postgres become UTC ranges", () => {
  assert.equal(contentPartitionName(new Date("2026-12-10T23:59:59.999Z")), "RequestLogContent_p20261210");
  assert.deepEqual(
    contentPartitionOf({
      name: "RequestLogContent_p20261210",
      bound: "FOR VALUES FROM ('2026-12-10 00:00:00') TO ('2026-12-11 00:00:00')",
      bytes: 123,
    }),
    { name: "RequestLogContent_p20261210", from: day(0), to: day(1), bytes: 123 },
  );
  const legacy = contentPartitionOf({ name: "RequestLogContent_legacy", bound: "FOR VALUES FROM (MINVALUE) TO ('2026-11-20 00:00:00')", bytes: 5 });
  assert.deepEqual([legacy.from, legacy.to?.toISOString()], [null, "2026-11-20T00:00:00.000Z"]);
  assert.deepEqual(contentPartitionOf({ name: "RequestLogContent_default", bound: "DEFAULT", bytes: 0 }), {
    name: "RequestLogContent_default",
    from: null,
    to: null,
    bytes: 0,
  });
});

test("only days without a partition are created, and the day the older rows still cover is skipped", () => {
  const coveringToday: ContentPartition = { ...LEGACY, to: day(1) };
  assert.deepEqual(
    missingContentDays([coveringToday, DEFAULT, daily(1), daily(3)], NOW, 4).map((date) => date.toISOString().slice(0, 10)),
    ["2026-12-12", "2026-12-14"],
  );
  assert.equal(missingContentDays([LEGACY, DEFAULT], NOW).length, 8);
  assert.deepEqual(
    missingContentDays([LEGACY, DEFAULT], NOW, 2, [new Date("2026-12-11T09:00:00.000Z")]).map((date) => date.toISOString().slice(0, 10)),
    ["2026-12-10", "2026-12-12"],
  );
  assert.deepEqual(missingContentDays([LEGACY, ...[0, 1, 2, 3, 4, 5, 6, 7].map((offset) => daily(offset))], NOW), []);
});

test("days past the retention are dropped whole, the day the cutoff falls into stays for row deletes", () => {
  const partitions = [DEFAULT, LEGACY, daily(-9), daily(-8), daily(-7), daily(-1), daily(0), daily(1, 16_384)];
  const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);
  assert.deepEqual(
    expiredContentPartitions(partitions, { now: NOW, cutoff, maxBytes: 0 }).map((partition) => partition.name),
    ["RequestLogContent_legacy", contentPartitionName(day(-9)), contentPartitionName(day(-8))],
  );
  assert.deepEqual(expiredContentPartitions(partitions, { now: NOW, cutoff: null, maxBytes: 0 }), []);
});

test("the size limit drops the oldest days first and never the current day", () => {
  const partitions = [DEFAULT, daily(-3, 4 * GIB), daily(-2, 3 * GIB), daily(-1, 2 * GIB), daily(0, 6 * GIB), daily(1, 16_384)];
  const names = (maxBytes: number, cutoff: Date | null = null) =>
    expiredContentPartitions(partitions, { now: NOW, cutoff, maxBytes }).map((partition) => partition.name);
  assert.deepEqual(names(20 * GIB), []);
  assert.deepEqual(names(12 * GIB), [contentPartitionName(day(-3))]);
  assert.deepEqual(names(9 * GIB), [contentPartitionName(day(-3)), contentPartitionName(day(-2))]);
  assert.deepEqual(names(GIB), [-3, -2, -1].map((offset) => contentPartitionName(day(offset))));
  assert.deepEqual(names(12 * GIB, day(-2)), [contentPartitionName(day(-3))]);
  const withLegacy = [LEGACY, daily(-1, GIB), daily(0, GIB)];
  assert.deepEqual(
    expiredContentPartitions(withLegacy, { now: NOW, cutoff: null, maxBytes: 10 * GIB }).map((partition) => partition.name),
    ["RequestLogContent_legacy"],
  );
  const foreign = [{ ...daily(-5), name: "RequestLogContent_custom" }, daily(0)];
  assert.deepEqual(expiredContentPartitions(foreign, { now: NOW, cutoff: day(0), maxBytes: 1 }), []);
});

test("the partition policy follows the shorter of log and content retention and the saved size limit", () => {
  const policy = (settings: Record<string, number>) => contentPartitionPolicy(normalizeEnterprise(settings), NOW);
  assert.equal(policy({}).cutoff?.getTime(), NOW.getTime() - 30 * DAY_MS);
  assert.equal(policy({}).maxBytes, 0);
  assert.equal(policy({ content_retention_days: 7 }).cutoff?.getTime(), NOW.getTime() - 7 * DAY_MS);
  assert.equal(policy({ content_retention_days: 0, log_retention_days: 14 }).cutoff?.getTime(), NOW.getTime() - 14 * DAY_MS);
  assert.equal(policy({ content_retention_days: 60, log_retention_days: 14 }).cutoff?.getTime(), NOW.getTime() - 14 * DAY_MS);
  assert.equal(policy({ content_retention_days: 0, log_retention_days: 0 }).cutoff, null);
  assert.equal(policy({ content_max_gb: 20 }).maxBytes, 20 * GIB);
  assert.equal(contentMaxBytes(undefined), 0);
  assert.equal(contentMaxBytes(-3), 0);
  assert.deepEqual([clampContentMaxGb(-1), clampContentMaxGb(2.26), clampContentMaxGb(Number.NaN), clampContentMaxGb(1e9)], [0, 2.3, 0, 100_000]);
});
