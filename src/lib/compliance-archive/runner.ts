import "server-only";

import { createHash } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/alerts/notify";
import { ARCHIVE_SOURCES } from "@/lib/compliance-archive/datasets";
import { archiveEncoding } from "@/lib/compliance-archive/encoders";
import { archiveErrorCode } from "@/lib/compliance-archive/errors";
import {
  ARCHIVE_ALERT_AFTER_ATTEMPTS,
  addDays,
  archiveBaseKey,
  archiveObjectLock,
  dayKey,
  lastClosedDay,
  lastExpiredDay,
  objectLockHeaders,
  planDays,
  retryDelayMs,
  utcDay,
} from "@/lib/compliance-archive/plan";
import { DEFAULT_COMPLIANCE_ARCHIVE } from "@/lib/compliance-archive/settings";
import { jsonLines } from "@/lib/compliance-archive/streams";
import { env } from "@/lib/env";
import { acquireLease, releaseLease, renewLease } from "@/lib/jobs/lease";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { s3Delete } from "@/lib/s3/client";
import { s3FromParts } from "@/lib/s3/config";
import { s3UploadStream } from "@/lib/s3/upload";
import { joinKey } from "@/lib/s3/url";
import { getEnterprise } from "@/lib/settings/enterprise";
import { currentBuild } from "@/lib/updates/build";
import type {
  ArchiveDataset,
  ArchiveDayResult,
  ArchiveManifest,
  ArchiveRunRow,
  ArchiveTick,
  ComplianceArchiveSettings,
} from "@/types/archive";
import type { S3Runtime } from "@/types/s3";
import type { Enterprise } from "@/types/settings";

export const ARCHIVE_LEASE = "compliance_archive_lock";
const ARCHIVE_LEASE_MS = 15 * 60_000;
const ARCHIVE_RENEW_MS = 60_000;
const ARCHIVE_TICK_BUDGET_MS = 10 * 60_000;
const ARCHIVE_DUE_BATCH = 50;
const ARCHIVE_EXPIRE_BATCH = 200;
const RUN_SELECT = { id: true, dataset: true, day: true, status: true, attempts: true, startedAt: true } as const;

class LeaseLostError extends Error {
  constructor() {
    super("LEASE_LOST");
    this.name = "LeaseLostError";
  }
}

class ArchiveLease {
  private renewedAt = Date.now();

  constructor(private token: string) {}

  get value(): string {
    return this.token;
  }

  async keep(): Promise<void> {
    if (Date.now() - this.renewedAt < ARCHIVE_RENEW_MS) return;
    const next = await renewLease(ARCHIVE_LEASE, this.token, ARCHIVE_LEASE_MS);
    if (!next) throw new LeaseLostError();
    this.token = next;
    this.renewedAt = Date.now();
  }
}

function archiveSettings(enterprise: Enterprise): ComplianceArchiveSettings {
  return enterprise.compliance_archive ?? DEFAULT_COMPLIANCE_ARCHIVE;
}

function credentials() {
  return { S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY };
}

export function archiveRuntime(enterprise: Enterprise, bucket = archiveSettings(enterprise).bucket): S3Runtime | null {
  const storage = enterprise.s3;
  if (!storage) return null;
  return s3FromParts({ ...storage, bucket: bucket || storage.bucket }, credentials());
}

function storedObjectRuntime(enterprise: Enterprise, bucket: string): S3Runtime | null {
  const runtime = archiveRuntime(enterprise, bucket);
  return runtime ? { ...runtime, prefix: "" } : null;
}

export async function planArchiveRuns(datasets: readonly ArchiveDataset[], now: Date): Promise<number> {
  const last = lastClosedDay(now);
  let planned = 0;
  for (const dataset of datasets) {
    const latest = await prisma.complianceArchiveRun.findFirst({
      where: { dataset },
      orderBy: { day: "desc" },
      select: { day: true },
    });
    const oldest = latest ? null : await ARCHIVE_SOURCES[dataset].oldest();
    const first = latest ? addDays(utcDay(latest.day), 1) : oldest ? utcDay(oldest) : last;
    const days = planDays(first, last);
    if (!days.length) continue;
    const created = await prisma.complianceArchiveRun.createMany({
      data: days.map((day) => ({ dataset, day, status: "pending", nextAttemptAt: now })),
      skipDuplicates: true,
    });
    planned += created.count;
  }
  return planned;
}

async function exportDay(
  run: ArchiveRunRow,
  settings: ComplianceArchiveSettings,
  runtime: S3Runtime,
  lease: ArchiveLease,
): Promise<ArchiveDayResult> {
  const dataset = run.dataset as ArchiveDataset;
  const source = ARCHIVE_SOURCES[dataset];
  const day = utcDay(run.day);
  const range = { from: day, to: addDays(day, 1) };
  const includeContent = dataset === "requests" && settings.include_content;
  const lock = archiveObjectLock(settings, day);
  if (!(await source.count(range))) {
    return { rows: 0, bytes: 0, sha256: "", objectKey: "", manifestKey: "", retainUntil: null };
  }
  const encoding = archiveEncoding(settings.format, settings.password);
  const base = archiveBaseKey(settings.prefix, dataset, day);
  const objectKey = `${base}${encoding.extension}`;
  const manifestKey = `${base}.manifest.json`;
  const headers = objectLockHeaders(lock);
  const tally = { rows: 0, bytes: 0, hash: createHash("sha256") };
  const records = source.records(range, { includeContent, onPage: () => lease.keep() });
  const body = encoding.encode(jsonLines(records, tally), { name: `${dataset}-${dayKey(day)}.jsonl`, modified: new Date() });
  const upload = await s3UploadStream(runtime, objectKey, body, { contentType: encoding.contentType, headers });
  await lease.keep();
  const manifest: ArchiveManifest = {
    version: 1,
    dataset,
    day: dayKey(day),
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    format: settings.format,
    object: joinKey(runtime.prefix, objectKey),
    content_type: encoding.contentType,
    encryption: encoding.encryption,
    compression: encoding.compression,
    includes_content: includeContent,
    records: tally.rows,
    records_bytes: tally.bytes,
    records_sha256: tally.hash.digest("hex"),
    bytes: upload.bytes,
    sha256: upload.sha256,
    retain_until: lock?.retainUntil.toISOString() ?? null,
    lock_mode: lock ? lock.mode : "none",
    created_at: new Date().toISOString(),
    build: currentBuild(),
  };
  await s3UploadStream(runtime, manifestKey, [Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)], {
    contentType: "application/json",
    headers,
  });
  return {
    rows: tally.rows,
    bytes: upload.bytes,
    sha256: upload.sha256,
    objectKey: manifest.object,
    manifestKey: joinKey(runtime.prefix, manifestKey),
    retainUntil: lock?.retainUntil ?? null,
  };
}

async function exportRun(
  run: ArchiveRunRow,
  settings: ComplianceArchiveSettings,
  runtime: S3Runtime,
  lease: ArchiveLease,
): Promise<boolean> {
  const attempts = run.attempts + 1;
  const day = dayKey(run.day);
  await prisma.complianceArchiveRun.update({
    where: { id: run.id },
    data: { status: "running", attempts, startedAt: new Date(), error: "", format: settings.format, bucket: runtime.bucket },
  });
  try {
    const result = await exportDay(run, settings, runtime, lease);
    await prisma.complianceArchiveRun.update({
      where: { id: run.id },
      data: {
        status: "done",
        rows: result.rows,
        bytes: BigInt(result.bytes),
        sha256: result.sha256,
        objectKey: result.objectKey,
        manifestKey: result.manifestKey,
        retainUntil: result.retainUntil,
        finishedAt: new Date(),
        error: "",
      },
    });
    logger.info("compliance_archive.exported", { dataset: run.dataset, day, rows: result.rows, bytes: result.bytes, attempts });
    return true;
  } catch (err) {
    const code = archiveErrorCode(err, settings.lock_mode !== "none");
    const failedAt = new Date();
    await prisma.complianceArchiveRun.update({
      where: { id: run.id },
      data: { status: "failed", error: code, finishedAt: failedAt, nextAttemptAt: new Date(failedAt.getTime() + retryDelayMs(attempts)) },
    });
    logger.error("compliance_archive.failed", { dataset: run.dataset, day, code, attempts, ...errorFields(err) });
    if (attempts === ARCHIVE_ALERT_AFTER_ATTEMPTS) {
      await fireAlert("archive_failed", `compliance archive ${run.dataset} ${day} failed ${attempts} times (${code})`);
    }
    if (err instanceof LeaseLostError) throw err;
    return false;
  }
}

async function exportDueRuns(
  settings: ComplianceArchiveSettings,
  runtime: S3Runtime,
  now: Date,
  lease: ArchiveLease,
  deadline: number,
): Promise<{ exported: number; failed: number }> {
  const due = await prisma.complianceArchiveRun.findMany({
    where: {
      dataset: { in: settings.datasets },
      OR: [{ status: { in: ["pending", "failed"] }, nextAttemptAt: { lte: now } }, { status: "running" }],
    },
    orderBy: [{ day: "asc" }, { dataset: "asc" }],
    take: ARCHIVE_DUE_BATCH,
    select: RUN_SELECT,
  });
  let exported = 0;
  let failed = 0;
  for (const run of due) {
    if (Date.now() >= deadline) break;
    await lease.keep();
    if (await exportRun(run, settings, runtime, lease)) exported += 1;
    else failed += 1;
  }
  return { exported, failed };
}

export async function expireArchiveObjects(enterprise: Enterprise, now: Date): Promise<number> {
  const settings = archiveSettings(enterprise);
  const lastDay = lastExpiredDay(now, settings.retention_days);
  if (!lastDay) return 0;
  const runs = await prisma.complianceArchiveRun.findMany({
    where: { status: "done", day: { lte: lastDay }, OR: [{ retainUntil: null }, { retainUntil: { lte: now } }] },
    orderBy: { day: "asc" },
    take: ARCHIVE_EXPIRE_BATCH,
    select: { id: true, dataset: true, day: true, bucket: true, objectKey: true, manifestKey: true },
  });
  let expired = 0;
  for (const run of runs) {
    try {
      if (run.objectKey || run.manifestKey) {
        const runtime = storedObjectRuntime(enterprise, run.bucket);
        if (!runtime) return expired;
        if (run.objectKey) await s3Delete(runtime, run.objectKey, AbortSignal.timeout(30_000));
        if (run.manifestKey) await s3Delete(runtime, run.manifestKey, AbortSignal.timeout(30_000));
      }
      await prisma.complianceArchiveRun.update({ where: { id: run.id }, data: { status: "expired", expiredAt: new Date() } });
      expired += 1;
    } catch (err) {
      logger.warn("compliance_archive.expire_failed", { dataset: run.dataset, day: dayKey(run.day), ...errorFields(err) });
    }
  }
  return expired;
}

export async function runComplianceArchive(now = new Date()): Promise<ArchiveTick> {
  const tick: ArchiveTick = { planned: 0, exported: 0, failed: 0, expired: 0, skipped: "" };
  const enterprise = await getEnterprise();
  const settings = archiveSettings(enterprise);
  if (!settings.enabled && settings.retention_days <= 0) return { ...tick, skipped: "disabled" };
  const runtime = archiveRuntime(enterprise);
  if (!runtime) return { ...tick, skipped: "storage" };
  const token = await acquireLease(ARCHIVE_LEASE, ARCHIVE_LEASE_MS);
  if (!token) return { ...tick, skipped: "busy" };
  const lease = new ArchiveLease(token);
  try {
    if (settings.enabled && settings.datasets.length) {
      tick.planned = await planArchiveRuns(settings.datasets, now);
      if (settings.format === "zip_aes" && !settings.password) {
        tick.skipped = "password";
      } else {
        Object.assign(tick, await exportDueRuns(settings, runtime, now, lease, Date.now() + ARCHIVE_TICK_BUDGET_MS));
      }
    }
    if (settings.retention_days > 0) tick.expired = await expireArchiveObjects(enterprise, now);
  } finally {
    await releaseLease(ARCHIVE_LEASE, lease.value).catch((err) => logger.warn("compliance_archive.release_failed", errorFields(err)));
  }
  return tick;
}

export function logArchiveTick(tick: ArchiveTick): void {
  if (tick.planned || tick.exported || tick.failed || tick.expired || tick.skipped === "password") {
    logger.info("compliance_archive.tick", tick);
  }
}
