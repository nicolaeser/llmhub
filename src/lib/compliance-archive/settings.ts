import { asBool, asNumber, asRecord, asString, asStringArray } from "@/lib/gateway/core";
import {
  ARCHIVE_DATASETS,
  ARCHIVE_FORMATS,
  ARCHIVE_LOCK_MODES,
  ARCHIVE_PREFIX_MAX,
  ARCHIVE_PREFIX_PATTERN,
  DEFAULT_ARCHIVE_PREFIX,
} from "@/lib/compliance-archive/options";
import { clampRetentionDays } from "@/lib/settings/retention-defaults";
import type { ArchiveDataset, ComplianceArchiveSettings } from "@/types/archive";

export const DEFAULT_COMPLIANCE_ARCHIVE: ComplianceArchiveSettings = {
  enabled: false,
  datasets: ["requests", "audit", "security"],
  format: "jsonl_gzip",
  password: "",
  include_content: true,
  bucket: "",
  prefix: DEFAULT_ARCHIVE_PREFIX,
  retention_days: 0,
  lock_mode: "none",
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

export function archivePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!trimmed || trimmed.length > ARCHIVE_PREFIX_MAX || !ARCHIVE_PREFIX_PATTERN.test(trimmed)) return DEFAULT_ARCHIVE_PREFIX;
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) return DEFAULT_ARCHIVE_PREFIX;
  return trimmed;
}

export function archiveDatasets(value: unknown): ArchiveDataset[] {
  const chosen = asStringArray(value);
  return ARCHIVE_DATASETS.filter((dataset) => chosen.includes(dataset));
}

export function normalizeComplianceArchive(raw: unknown): ComplianceArchiveSettings {
  const rec = asRecord(raw);
  if (!rec) return { ...DEFAULT_COMPLIANCE_ARCHIVE, datasets: [...DEFAULT_COMPLIANCE_ARCHIVE.datasets] };
  return {
    enabled: asBool(rec.enabled, false),
    datasets: Array.isArray(rec.datasets) ? archiveDatasets(rec.datasets) : [...DEFAULT_COMPLIANCE_ARCHIVE.datasets],
    format: oneOf(rec.format, ARCHIVE_FORMATS, DEFAULT_COMPLIANCE_ARCHIVE.format),
    password: asString(rec.password),
    include_content: asBool(rec.include_content, true),
    bucket: asString(rec.bucket).trim(),
    prefix: archivePrefix(asString(rec.prefix, DEFAULT_ARCHIVE_PREFIX)),
    retention_days: clampRetentionDays(asNumber(rec.retention_days, 0)),
    lock_mode: oneOf(rec.lock_mode, ARCHIVE_LOCK_MODES, "none"),
  };
}
