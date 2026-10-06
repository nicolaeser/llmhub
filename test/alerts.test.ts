import assert from "node:assert/strict";
import test from "node:test";
import { shouldAlert } from "@/lib/gateway/alerts";
import { RouterError } from "@/lib/gateway/core";

test("alerts on saturation and 5xx", () => {
  assert.equal(shouldAlert(new RouterError("no healthy", "no_healthy")), true);
  assert.equal(shouldAlert(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(shouldAlert(Object.assign(new Error("x"), { status: 400 })), false);
});
