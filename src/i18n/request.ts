import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";
import { loadLocaleMessages } from "./messages";
import { formats } from "./formats";
import { LOCALE_COOKIE, pickLocale } from "./locale-cookie";

export default getRequestConfig(async ({ requestLocale }) => {
  const [cookieStore, proxyLocale] = await Promise.all([cookies(), requestLocale]);
  const locale = pickLocale(
    [cookieStore.get(LOCALE_COOKIE.name)?.value, proxyLocale],
    routing.defaultLocale,
  );
  let messages;
  try {
    messages = await loadLocaleMessages(locale);
  } catch {
    messages = await loadLocaleMessages(routing.defaultLocale);
  }
  return {
    locale,
    messages,
    formats,
    now: new Date(),
  };
});
