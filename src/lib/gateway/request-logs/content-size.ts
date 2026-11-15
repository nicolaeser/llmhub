export function contentSizeBytes(request: unknown, response: unknown): number {
  const bytes = (value: unknown) => value === undefined || value === null ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
  return bytes(request) + bytes(response);
}

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function contentMaxBytes(gigabytes: number | undefined): number {
  return Number.isFinite(gigabytes) && gigabytes! > 0 ? Math.round(gigabytes! * 1024 ** 3) : 0;
}
