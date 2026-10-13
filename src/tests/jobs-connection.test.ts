import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvironment } from "@/lib/env";
import { getQueueConnectionOptions, jobsEnabled, redisUrl } from "@/lib/jobs/connection";

process.env.REDIS_URL = "  redis://cache:6379  ";

test("jobsEnabled is false without Redis", () => {
  assert.equal(jobsEnabled({}), false);
  assert.equal(jobsEnabled({ REDIS_URL: "" }), false);
  assert.equal(jobsEnabled({ REDIS_URL: "   " }), false);
});

test("REDIS_URL is the only Redis setting", () => {
  assert.equal(redisUrl({ REDIS_URL: " redis://127.0.0.1:6379 " }), "redis://127.0.0.1:6379");
  assert.equal(jobsEnabled({ REDIS_URL: "redis://redis:6379" }), true);
});

test("Redis settings come from the validated environment", () => {
  assert.equal(redisUrl(), "redis://cache:6379");
  assert.equal(jobsEnabled(), true);
  process.env.REDIS_URL = "redis://changed-after-boot:6379";
  assert.equal(redisUrl(), "redis://cache:6379");
  assert.deepEqual(getQueueConnectionOptions(), {
    url: "redis://cache:6379",
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
    enableOfflineQueue: false,
  });
  for (const value of ["", "   ", " redis://a:1 ", "rediss://user:pass@b:6380/2"]) {
    assert.equal(redisUrl({ REDIS_URL: value }), parseEnvironment({ ...process.env, REDIS_URL: value }).REDIS_URL, value);
  }
  assert.equal(redisUrl({ REDIS_URL: "redis://a:1", DATABASE_URL: "", APP_SECRET: "" }), "redis://a:1");
});
