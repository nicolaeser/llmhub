export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_CONTENT_RETENTION_DAYS = 30;
export const DEFAULT_SECURITY_RETENTION_DAYS = 90;
export const DEFAULT_OBJECT_RETENTION_DAYS = 30;
export const RETENTION_MAX_DAYS = 36500;

export function clampRetentionDays(value: number): number {
  return Math.min(RETENTION_MAX_DAYS, Math.max(0, Math.trunc(value) || 0));
}
