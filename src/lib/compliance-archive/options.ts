export const ARCHIVE_DATASETS = ["requests", "audit", "security", "tools"] as const;

export const ARCHIVE_FORMATS = ["jsonl", "jsonl_gzip", "zip_aes"] as const;

export const ARCHIVE_LOCK_MODES = ["none", "governance", "compliance"] as const;

export const ARCHIVE_RUN_STATUSES = ["pending", "running", "done", "failed", "expired"] as const;

export const ARCHIVE_ERROR_CODES = [
  "STORAGE_MISSING",
  "PASSWORD_MISSING",
  "AUTH",
  "SIGNATURE",
  "DENIED",
  "NO_BUCKET",
  "REGION",
  "LOCK_UNSUPPORTED",
  "UNREACHABLE",
  "LEASE_LOST",
  "FAILED",
] as const;

export const DEFAULT_ARCHIVE_PREFIX = "compliance-archive";

export const ARCHIVE_PASSWORD_MIN = 12;

export const ARCHIVE_PASSWORD_MAX = 256;

export const ARCHIVE_PREFIX_MAX = 200;

export const ARCHIVE_RECENT_RUNS = 30;

export const ARCHIVE_PREFIX_PATTERN = /^[A-Za-z0-9._/-]*$/;
