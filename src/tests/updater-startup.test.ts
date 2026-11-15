import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStartupStatus } from "../../scripts/startup-status.mjs";
import { inspectStartup, MIGRATION_WAIT_MS, STARTUP_STALE_MS, STARTUP_STATUS_PATH } from "../../scripts/updater/startup.mjs";
import { migrateDatabase } from "../../scripts/migrate-deploy.mjs";

const now = Date.now();
const iso = (time: number) => new Date(time).toISOString();
const info = { State: { Running: true, StartedAt: iso(now - 10_000) } };
const marker = { version: 1, bootId: "boot", bootStartedAt: iso(now - 9000), migrationStartedAt: iso(now - 9000), heartbeatAt: iso(now), state: "migrating", schemaChanged: "unknown" };
const inspect = (patch: object = {}, container = info) => inspectStartup({ readFile: async (_id: string, file: string) => {
  assert.equal(file, STARTUP_STATUS_PATH);
  return JSON.stringify({ ...marker, ...patch });
} }, "app", container, { now });

test("missing legacy markers are allowed but unreadable and malformed markers require recovery", async () => {
  assert.equal((await inspectStartup({ readFile: async () => { throw Object.assign(new Error(), { status: 404 }); } }, "old", info)).decision, "legacy");
  for (const raw of [null, "{", "{}", "x".repeat(16_385)]) {
    assert.equal((await inspectStartup({ readFile: async () => raw }, "app", info)).decision, "manual_recovery");
  }
  assert.equal((await inspectStartup({ readFile: async () => { throw new Error(); } }, "app", info)).decision, "manual_recovery");
});

test("only fresh current migrations wait and the separate migration deadline never authorizes rollback", async () => {
  assert.equal((await inspect()).decision, "wait");
  assert.equal((await inspect({ heartbeatAt: iso(now - STARTUP_STALE_MS - 1) })).decision, "manual_recovery");
  assert.equal((await inspect({}, { State: { Running: true, StartedAt: iso(now) } })).decision, "manual_recovery");
  assert.equal((await inspect({}, { State: { Running: false, StartedAt: iso(now - 10_000) } })).decision, "manual_recovery");
  const old = iso(now - MIGRATION_WAIT_MS - 1);
  const result = await inspect({ bootStartedAt: old, migrationStartedAt: old }, { State: { Running: true, StartedAt: old } });
  assert.equal(result.decision, "manual_recovery");
  assert.equal(result.rollbackSafe, false);
  assert.equal((await inspect({ state: "migration_failed" })).state, "migration_failed");
});

test("health evaluation retains the schema rollback barrier", async () => {
  for (const schemaChanged of [true, false, "unknown"]) {
    const result = await inspect({ state: "starting", schemaChanged });
    assert.equal(result.decision, "health");
    assert.equal(result.rollbackSafe, schemaChanged === false);
  }
});

test("hung archive reads are bounded and never accumulate parallel requests", async () => {
  let reads = 0;
  const docker = { readFile: () => { reads++; return new Promise(() => {}); } };
  for (let n = 0; n < 3; n++) {
    assert.equal((await inspectStartup(docker, "app", info, { readTimeoutMs: 5 })).decision, "manual_recovery");
  }
  assert.equal(reads, 1);
});

test("durable status changes boot identity and preserves schema risk through restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-startup-test-"));
  try {
    const file = path.join(dir, "status.json");
    const first = createStartupStatus(file);
    const initial = JSON.parse(await readFile(file, "utf8"));
    first.update({ state: "starting", schemaChanged: true });
    const second = createStartupStatus(file);
    second.update({ state: "starting", schemaChanged: false });
    const current = JSON.parse(await readFile(file, "utf8"));
    assert.notEqual(current.bootId, initial.bootId);
    assert.equal(current.schemaChanged, true);
    assert.ok(current.heartbeatAt);
    const interruptedFile = path.join(dir, "interrupted.json");
    createStartupStatus(interruptedFile);
    createStartupStatus(interruptedFile).update({ state: "starting", schemaChanged: false });
    assert.equal(JSON.parse(await readFile(interruptedFile, "utf8")).schemaChanged, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Prisma no-op evidence is distinguished from applied and ambiguous migrations", async () => {
  const env = { NODE_ENV: "production" as const, DATABASE_URL: "postgresql://test@localhost/test", APP_SECRET: "a".repeat(32) };
  const cases: [string, boolean | "unknown"][] = [["No pending migrations to apply.", false], ["Applying migration x\nAll migrations applied.", true], ["", "unknown"]];
  for (const [output, expected] of cases) {
    const result = await migrateDatabase({ env, write: () => {}, run: async () => ({ code: 0, signal: null, output }) });
    assert.equal(result?.schemaChanged, expected);
  }
  const observed: unknown[] = [];
  const result = await migrateDatabase({ env, write: () => {}, onStatus: (status: unknown) => observed.push(status),
    run: async (_args: unknown, _env: unknown, output: (chunk: string) => void) => {
      output("Applying mig"); output("ration x\n");
      return { code: 0, signal: null, output: "No pending migrations to apply." };
    },
  });
  assert.equal(result?.schemaChanged, true);
  assert.deepEqual(observed[0], { schemaChanged: true });
});

test("a successful no-op startup is rollback-safe until a failed attempt makes it uncertain", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-startup-noop-"));
  try {
    const file = path.join(dir, "status.json");
    const status = createStartupStatus(file);
    status.update({ schemaChanged: false });
    status.update({ state: "starting" });
    assert.equal(JSON.parse(await readFile(file, "utf8")).schemaChanged, false);
    const reboot = createStartupStatus(file);
    reboot.update({ state: "migration_failed" });
    reboot.update({ state: "starting", schemaChanged: false });
    assert.equal(JSON.parse(await readFile(file, "utf8")).schemaChanged, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
