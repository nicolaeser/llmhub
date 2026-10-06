import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { MAX_MEMORY_WINDOWS, allowInMemory, resetRequestWindows } from "@/lib/rate-limit/window";

const APP = "https://hub.example.com";

test("same-origin check accepts the app origin and the request host", () => {
  assert.equal(isSameOriginRequest(new Headers({ origin: APP }), APP), true);
  assert.equal(
    isSameOriginRequest(new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }), APP),
    true,
  );
  assert.equal(
    isSameOriginRequest(
      new Headers({ origin: "https://proxy.example.com", "x-forwarded-host": "proxy.example.com", host: "app:3000" }),
      APP,
    ),
    true,
  );
  assert.equal(isSameOriginRequest(new Headers({ "sec-fetch-site": "same-origin" }), APP), true);
  assert.equal(isSameOriginRequest(new Headers(), APP), true);
});

test("same-origin check rejects cross-site and opaque origins", () => {
  assert.equal(isSameOriginRequest(new Headers({ origin: "https://evil.example" }), APP), false);
  assert.equal(isSameOriginRequest(new Headers({ origin: "null" }), APP), false);
  assert.equal(isSameOriginRequest(new Headers({ "sec-fetch-site": "cross-site", origin: APP }), APP), false);
  assert.equal(isSameOriginRequest(new Headers({ "sec-fetch-site": "same-site" }), APP), false);
  assert.equal(
    isSameOriginRequest(new Headers({ origin: "https://evil.example", host: "hub.example.com" }), APP),
    false,
  );
});

test("memory request windows enforce the limit and reset after the window", () => {
  resetRequestWindows();
  const now = 1_000_000;
  assert.equal(allowInMemory("k", 2, 60_000, now), true);
  assert.equal(allowInMemory("k", 2, 60_000, now + 1), true);
  assert.equal(allowInMemory("k", 2, 60_000, now + 2), false);
  assert.equal(allowInMemory("other", 2, 60_000, now + 2), true);
  assert.equal(allowInMemory("k", 2, 60_000, now + 60_000), true);
});

test("memory request windows stay bounded and fail closed when full of live windows", () => {
  resetRequestWindows();
  const now = 2_000_000;
  for (let i = 0; i < MAX_MEMORY_WINDOWS; i++) allowInMemory(`fill:${i}`, 5, 60_000, now);
  assert.equal(allowInMemory("late", 5, 60_000, now + 1), false);
  assert.equal(allowInMemory("late", 5, 60_000, now + 60_000), true);
  resetRequestWindows();
});
