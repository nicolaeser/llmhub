export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_CONTENT_RETENTION_DAYS = 30;
export const DEFAULT_SECURITY_RETENTION_DAYS = 90;
export const DEFAULT_OBJECT_RETENTION_DAYS = 30;
export const RETENTION_MAX_DAYS = 36500;

export const CONTENT_MAX_GB_LIMIT = 100_000;
export const CONTENT_SIZE_NOTICE_BYTES = 10 * 1024 ** 3;

export function clampContentMaxGb(value: number): number {
  return Math.min(CONTENT_MAX_GB_LIMIT, Math.max(0, Math.round((Number(value) || 0) * 10) / 10));
}

export function clampRetentionDays(value: number): number {
  return Math.min(RETENTION_MAX_DAYS, Math.max(0, Math.trunc(value) || 0));
}
