import assert from "node:assert/strict";
import test from "node:test";
import {
  isTryBearer,
  mintTryBearer,
  TRY_BEARER_TTL_SEC,
  verifyTryBearer,
} from "@/lib/gateway/try-bearer";

test("mintTryBearer verifies and expires", () => {
  const now = 1_700_000_000;
  const token = mintTryBearer("user-1", now);
  assert.equal(isTryBearer(token), true);
  assert.deepEqual(verifyTryBearer(token, now), { userId: "user-1" });
  assert.deepEqual(verifyTryBearer(token, now + TRY_BEARER_TTL_SEC - 1), {
    userId: "user-1",
  });
  assert.equal(verifyTryBearer(token, now + TRY_BEARER_TTL_SEC + 1), null);
});

test("verifyTryBearer rejects a tampered token", () => {
  const token = mintTryBearer("user-1", 1_700_000_000);
  assert.equal(verifyTryBearer(`${token}x`, 1_700_000_000), null);
  assert.equal(verifyTryBearer("sk-hub-not-try.nope", 1_700_000_000), null);
  assert.equal(isTryBearer("sk-hub-abc"), false);
});
