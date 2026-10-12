import assert from "node:assert/strict";
import test from "node:test";
import { shouldAlert } from "@/lib/alerts/notify";
import { ERR_ALL_PAUSED, ERR_NOT_ASSIGNED, RouterError } from "@/lib/gateway/core";

test("alerts on saturation and 5xx", () => {
  assert.equal(shouldAlert(new RouterError("no healthy", "no_healthy")), true);
  assert.equal(shouldAlert(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(shouldAlert(Object.assign(new Error("x"), { status: 400 })), false);
});

test("does not alert when every deployment is paused on purpose", () => {
  assert.equal(shouldAlert(ERR_ALL_PAUSED), false);
  assert.equal(shouldAlert(ERR_NOT_ASSIGNED), false);
});
