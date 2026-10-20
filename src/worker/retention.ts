import "server-only";

const MS_PER_DAY = 86_400_000;

export function retentionCutoff(days: number, now: Date): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export function shorterRetention(...days: number[]): number {
  const limited = days.filter((value) => Number.isFinite(value) && value > 0);
  return limited.length ? Math.min(...limited) : 0;
}
