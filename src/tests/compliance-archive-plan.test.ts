import assert from "node:assert/strict";
import test from "node:test";
import { archiveErrorCode } from "@/lib/compliance-archive/errors";
import {
  archiveBaseKey,
  archiveObjectLock,
  archiveRetainUntil,
  archivedBefore,
  heldCutoff,
  holdArchivedTables,
  lastClosedDay,
  lastExpiredDay,
  objectLockHeaders,
  planDays,
  retentionHolds,
  retryDelayMs,
} from "@/lib/compliance-archive/plan";
import { DEFAULT_COMPLIANCE_ARCHIVE, archivePrefix, normalizeComplianceArchive } from "@/lib/compliance-archive/settings";
import { S3Error } from "@/lib/s3/client";
import { normalizeEnterprise } from "@/lib/settings/enterprise";
import { nextArchiveSettings } from "@/lib/settings/compliance-archive";
import { contentPartitionPolicy } from "@/worker/retention-sweep";
import type { ComplianceArchiveInput } from "@/types/archive";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

test("the last closed day waits for the grace period after midnight UTC", () => {
  assert.deepEqual(lastClosedDay(new Date("2026-11-11T00:10:00Z")), day("2026-11-09"));
  assert.deepEqual(lastClosedDay(new Date("2026-11-11T00:20:00Z")), day("2026-11-10"));
  assert.deepEqual(lastClosedDay(new Date("2026-11-11T23:59:59Z")), day("2026-11-10"));
});

test("planDays lists each UTC day once and stops at the limit", () => {
  assert.deepEqual(planDays(new Date("2026-10-30T13:00:00Z"), day("2026-11-01")), [day("2026-10-30"), day("2026-10-31"), day("2026-11-01")]);
  assert.deepEqual(planDays(day("2026-11-02"), day("2026-11-01")), []);
  assert.equal(planDays(day("2020-01-01"), day("2026-01-01"), 10).length, 10);
});

test("archive keys sort by data set, year, and month", () => {
  assert.equal(archiveBaseKey("compliance-archive", "requests", day("2026-11-10")), "compliance-archive/requests/2026/11/requests-2026-11-10");
  assert.equal(archiveBaseKey("a/b", "audit", day("2026-01-02")), "a/b/audit/2026/01/audit-2026-01-02");
});

test("retention and object lock run until the end of the day plus the retention days", () => {
  assert.equal(archiveRetainUntil(day("2026-11-10"), 0), null);
  assert.deepEqual(archiveRetainUntil(day("2026-11-10"), 30), day("2026-12-11"));
  assert.equal(archiveObjectLock({ lock_mode: "none", retention_days: 30 }, day("2026-11-10")), null);
  assert.equal(archiveObjectLock({ lock_mode: "compliance", retention_days: 0 }, day("2026-11-10")), null);
  const lock = archiveObjectLock({ lock_mode: "governance", retention_days: 365 }, day("2026-11-10"));
  assert.deepEqual(objectLockHeaders(lock), {
    "x-amz-object-lock-mode": "GOVERNANCE",
    "x-amz-object-lock-retain-until-date": "2027-11-11T00:00:00.000Z",
  });
  assert.deepEqual(objectLockHeaders(null), {});
});

test("objects expire only after their retain-until date plus a safety margin", () => {
  assert.equal(lastExpiredDay(new Date("2026-12-11T00:30:00Z"), 0), null);
  assert.deepEqual(lastExpiredDay(new Date("2026-12-11T00:30:00Z"), 30), day("2026-11-09"));
  assert.deepEqual(lastExpiredDay(new Date("2026-12-11T01:30:00Z"), 30), day("2026-11-10"));
});

test("retries back off and stay capped at a day", () => {
  assert.equal(retryDelayMs(1), 5 * 60_000);
  assert.equal(retryDelayMs(2), 15 * 60_000);
  assert.equal(retryDelayMs(50), 24 * 60 * 60_000);
});

test("database retention may delete only before the first day that is not archived", () => {
  assert.deepEqual(archivedBefore([]), new Date(0));
  assert.deepEqual(archivedBefore([{ dataset: "requests", day: day("2026-11-09"), status: "done" }]), day("2026-11-10"));
  assert.deepEqual(
    archivedBefore([
      { dataset: "requests", day: day("2026-11-07"), status: "failed" },
      { dataset: "requests", day: day("2026-11-09"), status: "done" },
    ]),
    day("2026-11-07"),
  );
  assert.deepEqual(archivedBefore([{ dataset: "requests", day: day("2026-11-01"), status: "expired" }]), day("2026-11-02"));
});

test("holds map archived data sets to their retention tables", () => {
  const settings = { enabled: true, datasets: ["requests", "audit"] as const, include_content: true };
  const holds = retentionHolds({ ...settings, datasets: [...settings.datasets] }, { requests: day("2026-11-05"), audit: day("2026-11-08") });
  assert.deepEqual(holds, { requestLogs: day("2026-11-05"), requestContents: day("2026-11-05"), auditLogs: day("2026-11-08") });
  assert.deepEqual(retentionHolds({ enabled: false, datasets: ["requests"], include_content: true }, {}), {});
  assert.deepEqual(
    holdArchivedTables({ enabled: true, datasets: ["requests", "security", "tools"], include_content: false }),
    { requestLogs: new Date(0), securityEvents: new Date(0), toolExecutions: new Date(0) },
  );
});

test("a hold only ever moves a retention cutoff earlier", () => {
  assert.equal(heldCutoff(null, day("2026-11-01")), null);
  assert.deepEqual(heldCutoff(day("2026-11-05"), undefined), day("2026-11-05"));
  assert.deepEqual(heldCutoff(day("2026-11-05"), day("2026-11-01")), day("2026-11-01"));
  assert.deepEqual(heldCutoff(day("2026-11-05"), day("2026-11-09")), day("2026-11-05"));
});

test("content partitions are not dropped before their day is archived", () => {
  const now = new Date("2026-12-10T12:00:00Z");
  const enterprise = normalizeEnterprise({ content_retention_days: 7, log_retention_days: 30 });
  assert.deepEqual(contentPartitionPolicy(enterprise, now).cutoff, new Date("2026-12-03T12:00:00Z"));
  assert.deepEqual(contentPartitionPolicy(enterprise, now, { requestContents: day("2026-11-30") }).cutoff, day("2026-11-30"));
});

test("archive settings normalize to safe defaults", () => {
  assert.deepEqual(normalizeComplianceArchive(undefined), DEFAULT_COMPLIANCE_ARCHIVE);
  const normalized = normalizeComplianceArchive({
    enabled: true,
    datasets: ["tools", "nope", "requests"],
    format: "rar",
    lock_mode: "forever",
    retention_days: -3,
    prefix: "../../etc",
  });
  assert.deepEqual(normalized.datasets, ["requests", "tools"]);
  assert.equal(normalized.format, DEFAULT_COMPLIANCE_ARCHIVE.format);
  assert.equal(normalized.lock_mode, "none");
  assert.equal(normalized.retention_days, 0);
  assert.equal(normalized.prefix, "compliance-archive");
  assert.equal(archivePrefix("/audits//llmhub/"), "audits/llmhub");
  assert.deepEqual(normalizeEnterprise({}).compliance_archive, DEFAULT_COMPLIANCE_ARCHIVE);
});

test("saving rejects settings that could not produce a usable archive", () => {
  const base: ComplianceArchiveInput = {
    enabled: true,
    datasets: ["requests"],
    format: "zip_aes",
    password: "",
    clearPassword: false,
    include_content: true,
    bucket: "",
    prefix: "compliance-archive",
    retention_days: 0,
    lock_mode: "none",
  };
  const previous = { ...DEFAULT_COMPLIANCE_ARCHIVE };
  assert.throws(() => nextArchiveSettings(base, previous), /ARCHIVE_PASSWORD_REQUIRED/);
  assert.throws(() => nextArchiveSettings({ ...base, password: "short" }, previous), /ARCHIVE_PASSWORD_WEAK/);
  assert.throws(() => nextArchiveSettings({ ...base, format: "jsonl", lock_mode: "compliance" }, previous), /ARCHIVE_LOCK_NEEDS_RETENTION/);
  assert.throws(() => nextArchiveSettings({ ...base, format: "jsonl", datasets: [] }, previous), /ARCHIVE_DATASETS_REQUIRED/);
  assert.equal(nextArchiveSettings({ ...base, password: "a long enough secret" }, previous).password, "a long enough secret");
  assert.equal(nextArchiveSettings(base, { ...previous, password: "kept from before" }).password, "kept from before");
  assert.throws(() => nextArchiveSettings({ ...base, clearPassword: true }, { ...previous, password: "kept from before" }), /ARCHIVE_PASSWORD_REQUIRED/);
  assert.equal(nextArchiveSettings({ ...base, format: "jsonl", clearPassword: true }, { ...previous, password: "x".repeat(20) }).password, "");
});

test("export failures become stable codes without provider text", () => {
  assert.equal(archiveErrorCode(new S3Error(403, "<Code>AccessDenied</Code><Message>secret detail</Message>"), false), "DENIED");
  assert.equal(archiveErrorCode(new S3Error(400, "<Code>InvalidRequest</Code>"), true), "LOCK_UNSUPPORTED");
  assert.equal(archiveErrorCode(new S3Error(400, "<Code>InvalidRequest</Code>"), false), "FAILED");
  assert.equal(archiveErrorCode(new S3Error(404, "<Code>NoSuchBucket</Code>"), false), "NO_BUCKET");
  assert.equal(archiveErrorCode(new TypeError("fetch failed"), false), "UNREACHABLE");
  assert.equal(archiveErrorCode(new Error("PASSWORD_MISSING"), false), "PASSWORD_MISSING");
  assert.equal(archiveErrorCode(new Error("connection reset by peer"), false), "FAILED");
});
