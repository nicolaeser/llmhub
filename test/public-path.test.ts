import assert from "node:assert/strict";
import test from "node:test";
import {
  routePathname,
  shouldHardenTransport,
} from "@/lib/http/public-path";

test("routePathname strips en/de prefixes", () => {
  assert.equal(routePathname("/"), "/");
  assert.equal(routePathname("/playground"), "/playground");
  assert.equal(routePathname("/en"), "/");
  assert.equal(routePathname("/en/playground"), "/playground");
  assert.equal(routePathname("/de/account/login"), "/account/login");
});

test("shouldHardenTransport stays off on local HTTP", () => {
  assert.equal(shouldHardenTransport("localhost", "http:"), false);
  assert.equal(shouldHardenTransport("127.0.0.1", "http"), false);
  assert.equal(shouldHardenTransport("hub.example", "https:"), true);
  assert.equal(shouldHardenTransport("hub.example", "http:"), false);
});
