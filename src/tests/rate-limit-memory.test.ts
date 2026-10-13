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
