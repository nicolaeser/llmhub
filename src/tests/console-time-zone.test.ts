import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFormatter, NextIntlClientProvider } from "next-intl";
import LogTable, { type LogsPayload } from "@/app/(app)/logs/_components/log-table";
import { formats } from "@/i18n/formats";
import {
  cookieTimeZone,
  FALLBACK_TIME_ZONE,
  preferredTimeZone,
  TIME_ZONE_COOKIE,
  timeZoneCookieValue,
  timeZoneFromCookieHeader,
} from "@/lib/utils/time-zone-cookie";
import type { RequestLogRow } from "@/types/logs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function namespaces(locale: string, names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, JSON.parse(readFileSync(path.join(root, "lang", locale, `${name}.json`), "utf8"))]),
  );
}

test("cookieTimeZone accepts IANA zones and rejects unknown, empty, or oversized values", () => {
  assert.equal(cookieTimeZone("Europe/Berlin"), "Europe/Berlin");
  assert.equal(cookieTimeZone("UTC"), "UTC");
  assert.equal(cookieTimeZone("America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires");
  assert.equal(cookieTimeZone("Mars/Olympus"), null);
  assert.equal(cookieTimeZone(""), null);
  assert.equal(cookieTimeZone(undefined), null);
  assert.equal(cookieTimeZone(null), null);
  assert.equal(cookieTimeZone(`Europe/${"x".repeat(80)}`), null);
});

test("timeZoneFromCookieHeader reads the encoded console zone from document.cookie", () => {
  assert.equal(timeZoneFromCookieHeader(`a=1; ${TIME_ZONE_COOKIE}=Europe%2FBerlin; b=2`), "Europe/Berlin");
  assert.equal(timeZoneFromCookieHeader(`${TIME_ZONE_COOKIE}=America/New_York`), "America/New_York");
  assert.equal(timeZoneFromCookieHeader(`x${TIME_ZONE_COOKIE}=Europe%2FBerlin`), null);
  assert.equal(timeZoneFromCookieHeader(`${TIME_ZONE_COOKIE}=Mars%2FOlympus`), null);
  assert.equal(timeZoneFromCookieHeader(`${TIME_ZONE_COOKIE}=%E0%A4%A`), null);
  assert.equal(timeZoneFromCookieHeader(""), null);
});

test("the written cookie round-trips and is secure only over https", () => {
  const value = timeZoneCookieValue("Europe/Berlin", true);
  assert.match(value, /^llmhub_time_zone=Europe%2FBerlin; path=\/; max-age=\d+; samesite=lax; secure$/);
  assert.doesNotMatch(timeZoneCookieValue("UTC", false), /secure/);
  assert.equal(timeZoneFromCookieHeader(value.split(";")[0]), "Europe/Berlin");
});

test("preferredTimeZone prefers the cookie, then a migrated dashboard zone, then the browser zone", () => {
  assert.equal(preferredTimeZone({ cookie: "Asia/Tokyo", legacy: "Europe/Paris", browser: "Europe/Berlin" }), "Asia/Tokyo");
  assert.equal(preferredTimeZone({ cookie: null, legacy: "Europe/Paris", browser: "Europe/Berlin" }), "Europe/Paris");
  assert.equal(preferredTimeZone({ cookie: "Mars/Olympus", legacy: "nope", browser: "Europe/Berlin" }), "Europe/Berlin");
  assert.equal(preferredTimeZone({ cookie: null, legacy: null, browser: null }), FALLBACK_TIME_ZONE);
});

test("UTC day labels stay on their day in any display zone", () => {
  for (const timeZone of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
    const format = createFormatter({ locale: "en", formats, timeZone });
    assert.equal(format.dateTime(new Date("2026-10-20T00:00:00Z"), "utcDay"), "Oct 20", timeZone);
  }
});

const ROW: RequestLogRow = {
  id: "req_1",
  createdAt: "2026-07-01T12:00:00.000Z",
  model: "gpt-test",
  endpoint: "/v1/chat/completions",
  stream: false,
  status: 200,
  outcome: "ok",
  latencyMs: 120,
  keyId: "",
  keyLabel: "",
  userId: "",
  userLabel: "",
  memberId: "",
  memberLabel: "",
  teamId: "",
  orgId: "",
  projectId: "",
  promptTokens: 10,
  completionTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.001,
  piiMode: "",
  piiInput: [],
  piiOutput: [],
  guardInput: [],
  guardOutput: [],
  hasContent: false,
  contentSkip: "",
  system: "",
};

const LOGS: LogsPayload = {
  canAudit: false,
  page: 1,
  pageSize: 50,
  requestTotal: 1,
  spendTotal: 1,
  auditTotal: 0,
  requests: [ROW],
  spend: [{ id: "sp_1", createdAt: "2026-01-15T12:00:00.000Z", model: "gpt-test", spend: 0.001, promptTokens: 10, completionTokens: 5 }],
  audit: [],
};

function renderLogs(locale: string, timeZone: string, kind: "requests" | "spend") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone,
      formats,
      now: new Date("2026-07-01T12:30:00.000Z"),
      messages: namespaces(locale, ["Common", "Logs", "Guardrails"]),
      children: createElement(LogTable, { kind, logs: LOGS, onOpen: () => {} }),
    }),
  );
}

test("the logs list shows request times in the console time zone with its name", () => {
  const berlin = renderLogs("en", "Europe/Berlin", "requests");
  assert.match(berlin, /02:00:00\s?PM GMT\+2/);
  assert.doesNotMatch(berlin, /12:00:00\s?PM/);
  const utc = renderLogs("en", "UTC", "requests");
  assert.match(utc, /12:00:00\s?PM UTC/);
  assert.match(renderLogs("de", "Europe/Berlin", "requests"), /14:00:00 MESZ/);
  assert.match(renderLogs("de", "Europe/Berlin", "spend"), /13:00:00 MEZ/);
});
