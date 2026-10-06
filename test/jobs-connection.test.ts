import assert from "node:assert/strict";
import test from "node:test";
import { jobsEnabled, redisUrl } from "@/lib/jobs/connection";

test("jobsEnabled is false without Redis", () => {
  assert.equal(jobsEnabled({}), false);
  assert.equal(jobsEnabled({ REDIS_URL: "" }), false);
});

test("REDIS_URL is the only Redis setting", () => {
  assert.equal(redisUrl({ REDIS_URL: " redis://127.0.0.1:6379 " }), "redis://127.0.0.1:6379");
  assert.equal(jobsEnabled({ REDIS_URL: "redis://redis:6379" }), true);
});
