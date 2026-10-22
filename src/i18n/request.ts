import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { cookieTimeZone, FALLBACK_TIME_ZONE, TIME_ZONE_COOKIE } from "@/lib/utils/time-zone-cookie";
import { routing } from "./routing";
import { loadLocaleMessages } from "./messages";
import { formats } from "./formats";

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as "de" | "en")) {
    locale = routing.defaultLocale;
  }
  let messages;
  try {
    messages = await loadLocaleMessages(locale);
  } catch {
    messages = await loadLocaleMessages(routing.defaultLocale);
  }
  const timeZone = cookieTimeZone((await cookies()).get(TIME_ZONE_COOKIE)?.value) ?? FALLBACK_TIME_ZONE;
  return {
    locale,
    messages,
    formats,
    now: new Date(),
    timeZone,
  };
});
