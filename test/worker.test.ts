import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { retentionCutoff } from "@/worker/retention";

const root = fileURLToPath(new URL("..", import.meta.url));

test("log retention cutoff is null when disabled", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(retentionCutoff(0, now), null);
  assert.equal(retentionCutoff(-1, now), null);
  assert.equal(
    retentionCutoff(14, now)?.toISOString(),
    "2026-08-24T12:00:00.000Z",
  );
});

test("instrumentation starts the worker after the catalog without static imports", async () => {
  const source = await readFile(path.join(root, "src/instrumentation.ts"), "utf8");
  assert.match(source, /NEXT_PHASE === "phase-production-build"/);
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /ioredis|bullmq/);
  const catalog = source.indexOf("await ensureSystemCatalog()");
  const worker = source.indexOf("startWorker()");
  assert.ok(catalog >= 0 && worker > catalog);
});

test("worker start does not await Redis readiness", async () => {
  const source = await readFile(path.join(root, "src/worker/boot.ts"), "utf8");
  assert.match(source, /void bootWorker\(\)/);
  assert.doesNotMatch(source, /process\.exit/);
});
