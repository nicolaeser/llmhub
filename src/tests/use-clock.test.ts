import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { createClock, useClock } from "@/lib/hooks/use-clock";

const MINUTE_MS = 60_000;
const PAGE_LOADED_AT = Date.UTC(2026, 9, 26, 20, 12);

beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"], now: PAGE_LOADED_AT }));
afterEach(() => mock.timers.reset());

test("a clock read after a long idle stretch starts from the current time", () => {
  const clock = createClock(MINUTE_MS);
  assert.equal(clock.read().getTime(), PAGE_LOADED_AT);
  mock.timers.tick(20 * MINUTE_MS);
  assert.equal(clock.read().getTime(), PAGE_LOADED_AT + 20 * MINUTE_MS);
});

test("a subscribed clock keeps one snapshot between ticks and notifies on each tick", () => {
  const clock = createClock(MINUTE_MS);
  let notified = 0;
  const unsubscribe = clock.subscribe(() => notified++);
  const first = clock.read();
  mock.timers.tick(MINUTE_MS - 1);
  assert.equal(clock.read(), first);
  assert.equal(notified, 0);
  mock.timers.tick(1);
  assert.equal(notified, 1);
  assert.equal(clock.read().getTime(), PAGE_LOADED_AT + MINUTE_MS);
  unsubscribe();
  mock.timers.tick(5 * MINUTE_MS);
  assert.equal(notified, 1);
});

test("useClock renders the request time on the server so hydration matches", () => {
  const requestNow = new Date(PAGE_LOADED_AT - 20 * MINUTE_MS);
  function Stamp() {
    return createElement("time", null, useClock(MINUTE_MS).toISOString());
  }
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "en", now: requestNow, timeZone: "UTC", children: createElement(Stamp) }),
  );
  assert.equal(html, `<time>${requestNow.toISOString()}</time>`);
});
