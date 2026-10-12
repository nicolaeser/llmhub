import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { jobsEnabled, redisUrl } from "@/lib/jobs/connection";

test("jobsEnabled is false without Redis", () => {
  assert.equal(jobsEnabled({}), false);
  assert.equal(jobsEnabled({ REDIS_URL: "" }), false);
  assert.equal(jobsEnabled({ REDIS_URL: "   " }), false);
});

test("REDIS_URL is the only Redis setting", () => {
  assert.equal(redisUrl({ REDIS_URL: " redis://127.0.0.1:6379 " }), "redis://127.0.0.1:6379");
  assert.equal(jobsEnabled({ REDIS_URL: "redis://redis:6379" }), true);
});

test("Redis settings come from the validated environment", async () => {
  const source = await readFile(new URL("../src/lib/jobs/connection.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env/);
  assert.match(source, /from "@\/lib\/env"/);
  assert.match(source, /envSchema\.pick\(\{ REDIS_URL: true \}\)/);
});
