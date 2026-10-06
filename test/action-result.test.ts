import assert from "node:assert/strict";
import test from "node:test";
import {
  actionFail,
  isActionFail,
  runAction,
} from "@/lib/http/action-result";

test("actionFail returns a failed action payload", () => {
  const fail = actionFail("not_allowed");
  assert.deepEqual(fail, {
    ok: false,
    error: "not_allowed",
    message: "not_allowed",
  });
});

test("isActionFail detects failed action payloads", () => {
  assert.equal(isActionFail(actionFail("nope")), true);
  assert.equal(isActionFail({ ok: true }), false);
  assert.equal(isActionFail(null), false);
});

test("runAction returns the value or a stable error code", async () => {
  assert.equal(await runAction(async () => 7), 7);
  const coded = await runAction(async () => {
    throw new Error("TEAM_NOT_FOUND");
  });
  assert.deepEqual(coded, actionFail("TEAM_NOT_FOUND"));
  const guarded = await runAction(async () => {
    throw new Error("Forbidden");
  });
  assert.deepEqual(guarded, actionFail("Forbidden"));
});

test("runAction never forwards raw exception text", async () => {
  for (const thrown of [new Error("relation \"User\" does not exist"), new Error("boom"), "x", null]) {
    const fail = await runAction(async () => {
      throw thrown;
    });
    assert.deepEqual(fail, actionFail("REQUEST_FAILED"));
  }
});
