import assert from "node:assert/strict";
import test from "node:test";
import {
  isSubAddPage,
  routePathname,
  shouldHardenTransport,
  subAddManagePath,
  subAddPath,
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

test("isSubAddPage matches only the add and manage pages with a full token", () => {
  const token = "x".repeat(43);
  assert.equal(subAddPath(token), `/providers/sub-add/${token}`);
  assert.equal(subAddManagePath(token), `/providers/sub-add/manage/${token}`);
  assert.equal(isSubAddPage(subAddPath(token)), true);
  assert.equal(isSubAddPage(subAddManagePath(token)), true);
  for (const path of [
    "/providers",
    "/providers/sub-add",
    "/providers/sub-add/manage",
    `/providers/sub-add/${token.slice(1)}`,
    `/providers/sub-add/${token}/`,
    `/providers/sub-add/${token}/x`,
    `/providers/sub-add/manage/${token}x`,
    `/providers/sub-add/%2E%2E/${token}`,
    `/x/providers/sub-add/${token}`,
  ]) {
    assert.equal(isSubAddPage(path), false, path);
  }
});
