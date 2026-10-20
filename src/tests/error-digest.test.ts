import assert from "node:assert/strict";
import test from "node:test";
import { errorDigest } from "@/lib/utils/error-digest";

test("errorDigest reads a non-empty string digest from thrown values", () => {
  assert.equal(errorDigest(Object.assign(new Error("boom"), { digest: "1059530004" })), "1059530004");
  assert.equal(errorDigest({ digest: "abc" }), "abc");
});

test("errorDigest ignores values without a usable digest", () => {
  assert.equal(errorDigest(new Error("boom")), null);
  assert.equal(errorDigest({ digest: "" }), null);
  assert.equal(errorDigest({ digest: 42 }), null);
  assert.equal(errorDigest("boom"), null);
  assert.equal(errorDigest(null), null);
  assert.equal(errorDigest(undefined), null);
});
