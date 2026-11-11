import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { REPEATED_FAILURE_LOG_EVERY, runKeeperCycle, type KeeperFailures } from "@/keeper/cycle";
import { heartbeatFresh, KEEPER_STALE_MS, writeHeartbeat } from "@/keeper/heartbeat";

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const record = (line: unknown) => lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  const log = mock.method(console, "log", record);
  const error = mock.method(console, "error", record);
  return {
    events: () => lines.map((line) => line.event),
    lines,
    restore: () => {
      log.mock.restore();
      error.mock.restore();
    },
  };
}

test("a failing keeper step never stops the others and is logged once, then at intervals, then on recovery", async () => {
  const failures: KeeperFailures = new Map();
  let databaseDown = true;
  const ran: string[] = [];
  const steps = [
    {
      name: "login_journal",
      run: async () => {
        ran.push("login_journal");
        if (databaseDown) throw new Error("connect ECONNREFUSED");
        return 2;
      },
    },
    {
      name: "sign_in_refresh",
      run: async () => {
        ran.push("sign_in_refresh");
        return 0;
      },
    },
  ];
  const logs = captureLogs();
  try {
    for (let cycle = 0; cycle < REPEATED_FAILURE_LOG_EVERY; cycle += 1) assert.equal(await runKeeperCycle(steps, failures), 0);
    assert.equal(ran.filter((name) => name === "sign_in_refresh").length, REPEATED_FAILURE_LOG_EVERY);
    assert.deepEqual(logs.events(), ["keeper.step_failed", "keeper.step_failed"]);
    assert.deepEqual(
      logs.lines.map((line) => line.consecutive),
      [1, REPEATED_FAILURE_LOG_EVERY],
    );
    assert.equal(logs.lines[0]?.errCode, undefined);
    assert.equal(logs.lines[0]?.err, "connect ECONNREFUSED");
    databaseDown = false;
    assert.equal(await runKeeperCycle(steps, failures), 2);
    assert.deepEqual(logs.events().slice(2), ["keeper.step_recovered", "keeper.step_done"]);
    assert.equal(failures.size, 0);
  } finally {
    logs.restore();
  }
});

test("the keeper is healthy only while its loop keeps writing the heartbeat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-keeper-"));
  const file = path.join(dir, "heartbeat");
  try {
    assert.equal(await heartbeatFresh(file), false);
    await writeHeartbeat(file);
    assert.equal(await heartbeatFresh(file), true);
    const stale = new Date(Date.now() - KEEPER_STALE_MS - 1_000);
    await utimes(file, stale, stale);
    assert.equal(await heartbeatFresh(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
