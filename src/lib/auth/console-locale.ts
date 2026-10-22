import "server-only";
import { cookies } from "next/headers";
import { requireActor } from "@/lib/auth/guards";
import { LOCALE_COOKIE, appLocaleOf } from "@/i18n/locale-cookie";

export async function setConsoleLocale(raw: unknown) {
  await requireActor();
  const locale = appLocaleOf(raw);
  if (!locale) throw new Error("VALIDATION");
  const { name, ...attributes } = LOCALE_COOKIE;
  (await cookies()).set(name, locale, attributes);
  return { locale };
}
