import { APP_LOCALES } from "@/lib/http/public-path";

export type AppLocale = (typeof APP_LOCALES)[number];

export const LOCALE_COOKIE = {
  name: "NEXT_LOCALE",
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 365,
} as const;

export function appLocaleOf(value: unknown): AppLocale | null {
  return APP_LOCALES.find((locale) => locale === value) ?? null;
}

export function pickLocale(candidates: readonly unknown[], fallback: AppLocale): AppLocale {
  for (const candidate of candidates) {
    const locale = appLocaleOf(candidate);
    if (locale) return locale;
  }
  return fallback;
}
