import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal health and ready use NextResponse.json", async () => {
  const health = await readFile(
    new URL("../src/app/internal-api/health/route.ts", import.meta.url),
    "utf8",
  );
  const ready = await readFile(
    new URL("../src/app/internal-api/ready/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(health, /NextResponse\.json/);
  assert.match(ready, /NextResponse\.json/);
  assert.match(ready, /prisma\.user\.count\(\)/);
  assert.doesNotMatch(ready, /\$queryRaw|\$executeRaw/);
  assert.doesNotMatch(health, /writeJSON/);
  assert.doesNotMatch(ready, /writeJSON/);
  assert.match(health, /from "@\/worker\/health"/);
  assert.match(health, /workerHealthPayload/);
  assert.match(health, /worker:\s*workerHealthPayload\(\)/);
});

test("internal health worker payload exposes worker.mode", async () => {
  const health = await readFile(
    new URL("../src/app/internal-api/health/route.ts", import.meta.url),
    "utf8",
  );
  const workerHealth = await readFile(
    new URL("../src/worker/health.ts", import.meta.url),
    "utf8",
  );
  assert.match(health, /workerHealthPayload/);
  assert.match(health, /worker:\s*workerHealthPayload\(\)/);
  assert.match(workerHealth, /export function workerHealthPayload/);
  assert.match(workerHealth, /return \{ mode: getWorkerMode\(\) \}/);
  const jobTypes = await readFile(new URL("../src/types/jobs.ts", import.meta.url), "utf8");
  assert.match(jobTypes, /"bullmq" \| "local" \| "unavailable"/);
});

test("api helper does not export writeJSON and errors use NextResponse.json", async () => {
  const source = await readFile(
    new URL("../src/lib/http/api.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /export function writeJSON/);
  const problem = await readFile(
    new URL("../src/lib/http/problem.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(problem, /export function writeJSON/);
  assert.match(problem, /NextResponse\.json/);
});

test("only /internal-api exposes health and ready", () => {
  for (const route of ["health", "health/ready", "metrics"]) {
    assert.equal(existsSync(new URL(`../src/app/${route}/route.ts`, import.meta.url)), false);
  }
});

test("internal version reports the build id uncached", async () => {
  process.env.BUILD_ID = "v2026.10.06.a449f56";
  const { GET } = await import("@/app/internal-api/version/route");
  const response = await GET();
  const body = await response.json();
  assert.equal(body.version, "v2026.10.06.a449f56");
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)));
  assert.ok(Date.parse(body.startedAt) <= Date.now());
  assert.equal(response.headers.get("cache-control"), "no-store");
});
