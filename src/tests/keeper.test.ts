import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { nextCycleDelay, REPEATED_FAILURE_LOG_EVERY, runKeeperCycle, waitForDatabase, type KeeperFailures } from "@/keeper/cycle";
import { heartbeatFresh, KEEPER_CYCLE_MS, KEEPER_RETRY_MS, KEEPER_STALE_MS, writeHeartbeat } from "@/keeper/heartbeat";
import { errorFields } from "@/lib/logging/format";

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
  const file = path.join(dir, "state", "heartbeat");
  try {
    assert.equal(await heartbeatFresh(file), false);
    await writeHeartbeat(file);
    assert.equal(await heartbeatFresh(file), true);
    assert.equal((await stat(path.join(dir, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const stale = new Date(Date.now() - KEEPER_STALE_MS - 1_000);
    await utimes(file, stale, stale);
    assert.equal(await heartbeatFresh(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const RECOVERING = "\nInvalid `prisma.providerLogin.count()` invocation:\n\n\nDatabase error. Code: `57P03`. Message: `the database system is not yet accepting connections`";

test("the keeper waits for a database that is still starting instead of failing its first cycle", async () => {
  const logs = captureLogs();
  try {
    let pings = 0;
    let beats = 0;
    const ready = await waitForDatabase(
      async () => {
        pings += 1;
        if (pings < 4) throw Object.assign(new Error(RECOVERING), { code: "P2039" });
      },
      { pauseMs: 1, onAttempt: async () => void (beats += 1) },
    );
    assert.equal(ready, true);
    assert.equal(pings, 4);
    assert.equal(beats, 3);
    assert.deepEqual(logs.events(), ["keeper.database_waiting", "keeper.database_ready"]);
    assert.equal(logs.lines[0]?.level, "info");
    assert.equal(logs.lines[0]?.errCode, "P2039");
    assert.match(String(logs.lines[0]?.err), /invocation: Database error\. Code: `57P03`\. Message: `the database system is not yet accepting connections`$/);
  } finally {
    logs.restore();
  }
});

test("the keeper stops waiting after its attempts, on a stop, and when the database never answers", async () => {
  const logs = captureLogs();
  try {
    const down = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    assert.equal(await waitForDatabase(down, { attempts: 3, pauseMs: 1 }), false);
    assert.deepEqual(logs.events(), ["keeper.database_waiting", "keeper.database_unavailable"]);
    assert.equal(logs.lines[1]?.level, "warn");
    let pings = 0;
    assert.equal(await waitForDatabase(async () => void (pings += 1), { stopped: () => true }), false);
    assert.equal(pings, 0);
    assert.equal(await waitForDatabase(() => new Promise(() => {}), { attempts: 1, pingMs: 5 }), false);
    assert.equal(logs.lines.at(-1)?.err, "the database did not answer in time");
    assert.equal(await waitForDatabase(async () => {}), true);
    let hanging = 0;
    const never = () => {
      hanging += 1;
      return new Promise(() => {});
    };
    assert.equal(await waitForDatabase(never, { attempts: 4, pauseMs: 1, pingMs: 2 }), false);
    assert.equal(hanging, 1);
    const startedAt = Date.now();
    assert.equal(await waitForDatabase(down, { attempts: 1_000, pauseMs: 0 }), false);
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    logs.restore();
  }
});

test("a failed cycle is tried again sooner, a healthy one keeps the cycle length", () => {
  assert.equal(nextCycleDelay(new Map()), KEEPER_CYCLE_MS);
  assert.equal(nextCycleDelay(new Map([["sign_in_refresh", 1]])), KEEPER_RETRY_MS[0]);
  assert.equal(nextCycleDelay(new Map([["login_journal", 1], ["sign_in_refresh", 3]])), KEEPER_RETRY_MS[2]);
  assert.equal(nextCycleDelay(new Map([["sign_in_refresh", KEEPER_RETRY_MS.length + 1]])), KEEPER_CYCLE_MS);
  assert.ok(KEEPER_RETRY_MS.every((delay) => delay < KEEPER_CYCLE_MS));
});

test("an error log line carries the reason below a heading line", () => {
  assert.equal(errorFields(new Error(RECOVERING)).err?.toString().startsWith("Invalid `prisma.providerLogin.count()` invocation: Database error."), true);
  assert.equal(errorFields(new Error("connect ECONNREFUSED\n    at stack")).err, "connect ECONNREFUSED");
  assert.equal(errorFields(new Error("heading:")).err, "heading:");
  assert.equal(String(errorFields(new Error(`heading:\n${"x".repeat(500)}`)).err).length, 300);
  assert.equal(
    errorFields(new Error('Invalid `prisma.user.create()` invocation:\n\nDatabase error. Code: `22P02`. Message: `invalid input syntax for type integer: "secret"`')).err,
    "Invalid `prisma.user.create()` invocation:",
  );
});
