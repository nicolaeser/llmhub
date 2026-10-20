import assert from "node:assert/strict";
import test from "node:test";
import {
  incrementRateWindow,
  resetRateLimitMemory,
} from "@/lib/rate-limit/shared";

test("memory rate window counts requests up front and tokens afterwards", async () => {
  resetRateLimitMemory();
  const first = await incrementRateWindow("mem-test", 1, 0);
  assert.equal(first.backend, "memory");
  assert.equal(first.rpm, 1);
  assert.equal(first.tpm, 0);
  const settled = await incrementRateWindow("mem-test", 0, 120);
  assert.equal(settled.rpm, 1);
  assert.equal(settled.tpm, 120);
  const next = await incrementRateWindow("mem-test", 1, 0);
  assert.equal(next.rpm, 2);
  assert.equal(next.tpm, 120);
});

test("memory rate window reports when the current minute resets", async () => {
  resetRateLimitMemory();
  const start = 1_700_000_000_000;
  const first = await incrementRateWindow("mem-reset", 1, 0, start);
  assert.equal(first.resetAt, start + 60_000);
  const later = await incrementRateWindow("mem-reset", 1, 0, start + 30_000);
  assert.equal(later.resetAt, start + 60_000);
  const rolled = await incrementRateWindow("mem-reset", 1, 0, start + 61_000);
  assert.equal(rolled.rpm, 1);
  assert.equal(rolled.resetAt, start + 121_000);
});
