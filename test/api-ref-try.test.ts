import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("api-ref try route is session-gated and stays on catalog paths", async () => {
  const source = await readFile(
    new URL("../src/app/internal-api/api-ref/try/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getSession/);
  assert.match(source, /PLAYGROUND/);
  assert.match(source, /resolveTryTarget/);
  assert.match(source, /mintTryBearer/);
  assert.match(source, /redirect: "manual"/);
  assert.doesNotMatch(source, /writeJSON/);
});

test("authenticateBearer accepts console try bearers", async () => {
  const source = await readFile(
    new URL("../src/lib/gateway/principal.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /isTryBearer/);
  assert.match(source, /verifyTryBearer/);
  assert.match(source, /PERMISSIONS\.PLAYGROUND/);
});
