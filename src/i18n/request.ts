import { getRequestConfig } from "next-intl/server";
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
  return {
    locale,
    messages,
    formats,
    now: new Date(),
  };
});
