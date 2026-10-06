import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("proxy.ts mentions createMiddleware or next-intl, SESSION_COOKIE, and /v1 exclusion in matcher", async () => {
  const source = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(source, /createMiddleware|next-intl/);
  assert.match(source, /SESSION_COOKIE/);
  assert.match(source, /verifySessionCookie/);
  assert.match(source, /matcher[\s\S]*v1/);
  assert.match(source, /internal-api/);
  assert.match(source, /sso\//);
  assert.match(source, /scim\//);
});
