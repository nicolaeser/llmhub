import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { archivedBeforeOf } from "@/lib/compliance-archive/holds";
import {
  ARCHIVE_ERROR_CODES,
  ARCHIVE_PASSWORD_MIN,
  ARCHIVE_RECENT_RUNS,
  ARCHIVE_RUN_STATUSES,
} from "@/lib/compliance-archive/options";
import { dayKey } from "@/lib/compliance-archive/plan";
import { archiveRuntime } from "@/lib/compliance-archive/runner";
import { DEFAULT_COMPLIANCE_ARCHIVE, normalizeComplianceArchive } from "@/lib/compliance-archive/settings";
import { requestArchiveRun } from "@/lib/compliance-archive/trigger";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { s3KeysPresent } from "@/lib/s3/config";
import { probeStorage } from "@/lib/s3/probe";
import { joinKey } from "@/lib/s3/url";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import { complianceArchiveInputSchema } from "@/schemas/settings";
import type {
  ArchiveDataset,
  ArchiveErrorCode,
  ArchiveRunStatus,
  ArchiveRunView,
  ArchiveSummary,
  ComplianceArchiveInput,
  ComplianceArchiveSettings,
  ComplianceArchiveView,
} from "@/types/archive";
import type { AuthenticatedSession } from "@/types/auth";
import type { S3ProbeResult } from "@/types/s3";
import type { Enterprise } from "@/types/settings";

type RunRow = {
  id: string;
  dataset: string;
  day: Date;
  status: string;
  rows: number;
  bytes: bigint;
  sha256: string;
  objectKey: string;
  attempts: number;
  error: string;
  finishedAt: Date | null;
  nextAttemptAt: Date;
  retainUntil: Date | null;
};

function current(enterprise: Enterprise): ComplianceArchiveSettings {
  return enterprise.compliance_archive ?? DEFAULT_COMPLIANCE_ARCHIVE;
}

function withoutPassword(settings: ComplianceArchiveSettings): Omit<ComplianceArchiveSettings, "password"> {
  return {
    enabled: settings.enabled,
    datasets: settings.datasets,
    format: settings.format,
    include_content: settings.include_content,
    bucket: settings.bucket,
    prefix: settings.prefix,
    retention_days: settings.retention_days,
    lock_mode: settings.lock_mode,
  };
}

function runStatus(value: string): ArchiveRunStatus {
  return ARCHIVE_RUN_STATUSES.find((status) => status === value) ?? "pending";
}

function runError(value: string): ArchiveErrorCode | "" {
  return ARCHIVE_ERROR_CODES.find((code) => code === value) ?? (value ? "FAILED" : "");
}

export function archiveRunView(row: RunRow): ArchiveRunView {
  const status = runStatus(row.status);
  return {
    id: row.id,
    dataset: row.dataset as ArchiveDataset,
    day: dayKey(row.day),
    status,
    rows: row.rows,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    objectKey: row.objectKey,
    attempts: row.attempts,
    error: status === "failed" ? runError(row.error) : "",
    finishedAt: row.finishedAt?.toISOString() ?? null,
    nextAttemptAt: status === "failed" ? row.nextAttemptAt.toISOString() : null,
    retainUntil: row.retainUntil?.toISOString() ?? null,
  };
}

async function summary(settings: ComplianceArchiveSettings): Promise<ArchiveSummary> {
  const [pending, failed, done, last] = await Promise.all([
    prisma.complianceArchiveRun.count({ where: { status: { in: ["pending", "running"] } } }),
    prisma.complianceArchiveRun.count({ where: { status: "failed" } }),
    prisma.complianceArchiveRun.count({ where: { status: { in: ["done", "expired"] } } }),
    prisma.complianceArchiveRun.findFirst({
      where: { status: { in: ["done", "expired"] } },
      orderBy: { day: "desc" },
      select: { day: true },
    }),
  ]);
  let heldSince: Date | null = null;
  if (settings.enabled) {
    for (const dataset of settings.datasets) {
      const before = await archivedBeforeOf(dataset);
      if (!heldSince || before < heldSince) heldSince = before;
    }
  }
  return {
    pending,
    failed,
    done,
    lastDay: last ? dayKey(last.day) : null,
    heldSince: heldSince && heldSince.getTime() > 0 ? dayKey(heldSince) : null,
  };
}

async function view(session: AuthenticatedSession, enterprise?: Enterprise): Promise<ComplianceArchiveView> {
  const ent = enterprise ?? (await getEnterprise());
  const settings = current(ent);
  const keys = s3KeysPresent();
  const runs = await prisma.complianceArchiveRun.findMany({
    orderBy: [{ day: "desc" }, { dataset: "asc" }],
    take: ARCHIVE_RECENT_RUNS,
    select: {
      id: true,
      dataset: true,
      day: true,
      status: true,
      rows: true,
      bytes: true,
      sha256: true,
      objectKey: true,
      attempts: true,
      error: true,
      finishedAt: true,
      nextAttemptAt: true,
      retainUntil: true,
    },
  });
  return {
    settings: withoutPassword(settings),
    passwordSet: Boolean(settings.password),
    storage: {
      ready: Boolean(ent.s3?.bucket) && keys.accessKeyId && keys.secretAccessKey,
      bucket: ent.s3?.bucket ?? "",
      storagePrefix: ent.s3?.prefix ?? "",
    },
    runs: runs.map(archiveRunView),
    summary: await summary(settings),
    canManage: hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

function parseInput(raw: unknown): ComplianceArchiveInput {
  const parsed = complianceArchiveInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

export function nextArchiveSettings(input: ComplianceArchiveInput, previous: ComplianceArchiveSettings): ComplianceArchiveSettings {
  if (input.password && input.password.length < ARCHIVE_PASSWORD_MIN) throw new Error("ARCHIVE_PASSWORD_WEAK");
  const password = input.clearPassword ? "" : input.password || previous.password;
  if (input.format === "zip_aes" && !password) throw new Error("ARCHIVE_PASSWORD_REQUIRED");
  if (input.lock_mode !== "none" && input.retention_days <= 0) throw new Error("ARCHIVE_LOCK_NEEDS_RETENTION");
  if (input.enabled && !input.datasets.length) throw new Error("ARCHIVE_DATASETS_REQUIRED");
  return normalizeComplianceArchive({
    enabled: input.enabled,
    datasets: input.datasets,
    format: input.format,
    password,
    include_content: input.include_content,
    bucket: input.bucket,
    prefix: input.prefix,
    retention_days: input.retention_days,
    lock_mode: input.lock_mode,
  });
}

async function kickArchive(): Promise<void> {
  try {
    await requestArchiveRun();
  } catch (err) {
    logger.warn("compliance_archive.request_failed", errorFields(err));
  }
}

export async function loadComplianceArchive() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(session);
}

export async function saveComplianceArchive(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parseInput(raw);
  const enterprise = await getEnterprise();
  const previous = current(enterprise);
  const next = nextArchiveSettings(input, previous);
  if (next.enabled && !archiveRuntime({ ...enterprise, compliance_archive: next })) throw new Error("ARCHIVE_STORAGE_REQUIRED");
  const saved = await patchEnterprise({ compliance_archive: next });
  await writeAudit({
    actor: session.user.id,
    action: "settings.compliance_archive",
    objectType: "enterprise",
    objectId: "enterprise",
    before: withoutPassword(previous),
    after: { ...withoutPassword(next), passwordChanged: next.password !== previous.password },
  });
  if (next.enabled || next.retention_days > 0) await kickArchive();
  return view(session, saved);
}

export async function testComplianceArchive(raw: unknown): Promise<S3ProbeResult> {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parseInput(raw);
  const keys = s3KeysPresent();
  if (!keys.accessKeyId || !keys.secretAccessKey) return { ok: false, code: "KEYS_MISSING", step: null, status: null };
  const enterprise = await getEnterprise();
  const runtime = archiveRuntime(enterprise, input.bucket);
  if (!runtime) return { ok: false, code: "BUCKET_MISSING", step: null, status: null };
  const prefix = normalizeComplianceArchive({ prefix: input.prefix }).prefix;
  const result = await probeStorage({ ...runtime, prefix: joinKey(runtime.prefix, prefix) });
  await writeAudit({
    actor: session.user.id,
    action: "settings.compliance_archive_test",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { endpoint: runtime.endpoint, bucket: runtime.bucket, ok: result.ok, ...(result.ok ? {} : { code: result.code }) },
  });
  return result;
}

export async function retryComplianceArchive() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const now = new Date();
  const retried = await prisma.complianceArchiveRun.updateMany({ where: { status: "failed" }, data: { nextAttemptAt: now } });
  await writeAudit({
    actor: session.user.id,
    action: "settings.compliance_archive_retry",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { runs: retried.count },
  });
  await kickArchive();
  return view(session);
}
