import { isTimeZone } from "@/lib/gateway/billing/price-schedule";

export const TIME_ZONE_COOKIE = "llmhub_time_zone";

export const FALLBACK_TIME_ZONE = "UTC";

const MAX_TIME_ZONE_LENGTH = 64;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function cookieTimeZone(value: string | null | undefined): string | null {
  return value && value.length <= MAX_TIME_ZONE_LENGTH && isTimeZone(value) ? value : null;
}

function decodedOr(value: string, fallback: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

export function timeZoneFromCookieHeader(header: string): string | null {
  for (const pair of header.split(/;\s*/)) {
    const split = pair.indexOf("=");
    if (split === -1 || pair.slice(0, split) !== TIME_ZONE_COOKIE) continue;
    return cookieTimeZone(decodedOr(pair.slice(split + 1), ""));
  }
  return null;
}

export function preferredTimeZone(sources: {
  cookie: string | null;
  legacy: string | null;
  browser: string | null;
}): string {
  return (
    cookieTimeZone(sources.cookie) ??
    cookieTimeZone(sources.legacy) ??
    cookieTimeZone(sources.browser) ??
    FALLBACK_TIME_ZONE
  );
}

export function browserTimeZone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

export function timeZoneCookieValue(timeZone: string, secure: boolean): string {
  return `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax${secure ? "; secure" : ""}`;
}

export function writeTimeZoneCookie(timeZone: string) {
  document.cookie = timeZoneCookieValue(timeZone, window.location.protocol === "https:");
}
