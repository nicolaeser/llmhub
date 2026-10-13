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

test("runAction logs the name and message of unexpected errors but not of action codes", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    await runAction(async () => {
      throw new Error("TEAM_NOT_FOUND");
    });
    assert.deepEqual(lines, []);
    await runAction(async () => {
      throw new TypeError("cannot read properties of undefined\n    at secret stack frame");
    });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.level, "error");
  assert.equal(entry.event, "action.failed");
  assert.equal(entry.errName, "TypeError");
  assert.equal(entry.err, "cannot read properties of undefined");
  assert.deepEqual(Object.keys(entry).sort(), ["err", "errName", "event", "level", "ts"]);
});
