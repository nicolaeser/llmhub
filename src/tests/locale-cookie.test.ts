import { cookies, setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { LOCALE_COOKIE, appLocaleOf, pickLocale } from "@/i18n/locale-cookie";
import { routing } from "@/i18n/routing";
import { setConsoleLocale } from "@/lib/auth/console-locale";
import { runAsPrincipal } from "@/lib/auth/delegation";
import type { AuthenticatedSession } from "@/types/auth";

const consoleUser = {
  error: false,
  sessionId: "s1",
  user: { id: "u1", username: "member", email: "member@example.com", orgId: null },
  isOwner: false,
  role: null,
  permissions: [],
  secondFactor: "TOTP",
  ipAddress: null,
  userAgent: null,
} as unknown as AuthenticatedSession;

test("appLocaleOf accepts only the console locales", () => {
  assert.equal(appLocaleOf("en"), "en");
  assert.equal(appLocaleOf("de"), "de");
  for (const value of ["DE", "de-DE", "fr", "", " de", undefined, null, 1, {}]) {
    assert.equal(appLocaleOf(value), null, String(value));
  }
});

test("pickLocale takes the first supported candidate so a chosen cookie outranks the proxy locale", () => {
  assert.equal(pickLocale(["de", "en"], "en"), "de");
  assert.equal(pickLocale([undefined, "de"], "en"), "de");
  assert.equal(pickLocale(["fr", "de"], "en"), "de");
  assert.equal(pickLocale([null, undefined, "xx"], "en"), "en");
  assert.equal(pickLocale([], "de"), "de");
});

test("the locale cookie keeps next-intl's name and attributes, lasts a year, and stays readable by global-error", () => {
  assert.deepEqual(LOCALE_COOKIE, { name: "NEXT_LOCALE", path: "/", sameSite: "lax", maxAge: 31_536_000 });
  assert.equal("httpOnly" in LOCALE_COOKIE, false);
  assert.equal(routing.localeCookie, LOCALE_COOKIE);
});

test("setConsoleLocale stores a supported locale for a console user and rejects anything else", async () => {
  setRequest();
  assert.deepEqual(await runAsPrincipal(consoleUser, () => setConsoleLocale("de")), { locale: "de" });
  assert.equal((await cookies()).get(LOCALE_COOKIE.name)?.value, "de");

  await assert.rejects(runAsPrincipal(consoleUser, () => setConsoleLocale("fr")), /^Error: VALIDATION$/);
  await assert.rejects(runAsPrincipal(consoleUser, () => setConsoleLocale(["en"])), /^Error: VALIDATION$/);
  assert.equal((await cookies()).get(LOCALE_COOKIE.name)?.value, "de");
});

test("setConsoleLocale needs a console session", async () => {
  setRequest();
  await assert.rejects(setConsoleLocale("de"), /^Error: Unauthorized$/);
  assert.equal((await cookies()).get(LOCALE_COOKIE.name), undefined);
});
