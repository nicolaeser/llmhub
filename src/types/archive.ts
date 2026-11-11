import type { z } from "zod";
import type {
  ARCHIVE_DATASETS,
  ARCHIVE_ERROR_CODES,
  ARCHIVE_FORMATS,
  ARCHIVE_LOCK_MODES,
  ARCHIVE_RUN_STATUSES,
} from "@/lib/compliance-archive/options";
import type { complianceArchiveInputSchema } from "@/schemas/settings";
import type { RetentionTable } from "@/types/jobs";

export type ArchiveDataset = (typeof ARCHIVE_DATASETS)[number];

export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

export type ArchiveLockMode = (typeof ARCHIVE_LOCK_MODES)[number];

export type ArchiveRunStatus = (typeof ARCHIVE_RUN_STATUSES)[number];

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number];

export type ComplianceArchiveSettings = {
  enabled: boolean;
  datasets: ArchiveDataset[];
  format: ArchiveFormat;
  password: string;
  include_content: boolean;
  bucket: string;
  prefix: string;
  retention_days: number;
  lock_mode: ArchiveLockMode;
};

export type ComplianceArchiveInput = z.infer<typeof complianceArchiveInputSchema>;

export type ArchiveRecord = Record<string, unknown>;

export type ArchiveDayRange = { from: Date; to: Date };

export type ArchiveReadOptions = {
  includeContent: boolean;
  pageSize?: number;
  onPage?: () => Promise<void>;
};

export type ArchiveSource = {
  dataset: ArchiveDataset;
  oldest: () => Promise<Date | null>;
  count: (range: ArchiveDayRange) => Promise<number>;
  records: (range: ArchiveDayRange, options: ArchiveReadOptions) => AsyncIterable<ArchiveRecord>;
};

export type ArchiveEntry = { name: string; modified: Date };

export type ArchiveEncoding = {
  format: ArchiveFormat;
  extension: string;
  contentType: string;
  encryption: "none" | "winzip-aes-256";
  compression: "none" | "gzip" | "deflate";
  encode: (lines: AsyncIterable<Buffer>, entry: ArchiveEntry) => AsyncIterable<Buffer>;
};

export type ArchiveObjectLock = { mode: Exclude<ArchiveLockMode, "none">; retainUntil: Date };

export type ArchiveUploadResult = { bytes: number; sha256: string; parts: number };

export type ArchiveManifest = {
  version: 1;
  dataset: ArchiveDataset;
  day: string;
  from: string;
  to: string;
  format: ArchiveFormat;
  object: string;
  content_type: string;
  encryption: ArchiveEncoding["encryption"];
  compression: ArchiveEncoding["compression"];
  includes_content: boolean;
  records: number;
  records_bytes: number;
  records_sha256: string;
  bytes: number;
  sha256: string;
  retain_until: string | null;
  lock_mode: ArchiveLockMode;
  created_at: string;
  build: string;
};

export type ArchiveDayResult = {
  rows: number;
  bytes: number;
  sha256: string;
  objectKey: string;
  manifestKey: string;
  retainUntil: Date | null;
};

export type ArchiveRunRow = {
  id: string;
  dataset: string;
  day: Date;
  status: string;
  attempts: number;
  startedAt: Date | null;
};

export type ArchiveHoldRun = { dataset: string; day: Date; status: string };

export type RetentionHolds = Partial<Record<RetentionTable, Date>>;

export type ArchiveTick = {
  planned: number;
  exported: number;
  failed: number;
  expired: number;
  skipped: "" | "disabled" | "storage" | "password" | "busy";
};

export type ArchiveRunView = {
  id: string;
  dataset: ArchiveDataset;
  day: string;
  status: ArchiveRunStatus;
  rows: number;
  bytes: number;
  sha256: string;
  objectKey: string;
  attempts: number;
  error: ArchiveErrorCode | "";
  finishedAt: string | null;
  nextAttemptAt: string | null;
  retainUntil: string | null;
};

export type ArchiveSummary = {
  pending: number;
  failed: number;
  done: number;
  lastDay: string | null;
  heldSince: string | null;
};

export type ComplianceArchiveView = {
  settings: Omit<ComplianceArchiveSettings, "password">;
  passwordSet: boolean;
  storage: { ready: boolean; bucket: string; storagePrefix: string };
  runs: ArchiveRunView[];
  summary: ArchiveSummary;
  canManage: boolean;
};
