import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { keeperEmbedded, retryDelay, supervise } from "../../scripts/start.mjs";

type Command = [string, string[]];

function script(code: string): Command {
  return [process.execPath, ["-e", code]];
}

function recorder(file: string, word: string) {
  return `require("node:fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${word}\n`)});`;
}

function longRunning(file: string, name: string, stopCode = 0): Command {
  return script(
    `${recorder(file, `${name}:start`)} process.on("SIGTERM", () => { ${recorder(file, `${name}:stop`)} process.exit(${stopCode}); }); setInterval(() => {}, 1000);`,
  );
}

async function lines(file: string): Promise<string[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out");
    await sleep(20);
  }
}

async function withRun(run: (file: string, events: () => Record<string, unknown>[]) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-start-"));
  const logged: Record<string, unknown>[] = [];
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    const text = String(chunk);
    if (text.startsWith('{"ts"')) logged.push(JSON.parse(text) as Record<string, unknown>);
    return true;
  });
  try {
    await run(path.join(dir, "trace"), () => logged);
  } finally {
    write.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the embedded keeper is on unless a separate keeper service is configured", () => {
  assert.equal(keeperEmbedded({} as NodeJS.ProcessEnv), true);
  assert.equal(keeperEmbedded({ LLMHUB_KEEPER: "embedded" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(keeperEmbedded({ LLMHUB_KEEPER: " Separate " } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(retryDelay([1, 2, 3], 0), 1);
  assert.equal(retryDelay([1, 2, 3], 7), 3);
  assert.equal(retryDelay([1, 2, 3], -1), 1);
});

test("the keeper starts after the first migration attempt and keeps running while a failing migration is retried", async () => {
  await withRun(async (trace, events) => {
    const counter = `${trace}.migrations`;
    const signals = new EventEmitter();
    const done = supervise({
      keeper: longRunning(trace, "keeper"),
      migrate: script(
        `const fs = require("node:fs"); const n = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8") : 0) + 1; fs.writeFileSync(${JSON.stringify(counter)}, String(n)); ${recorder(trace, "migrate")} process.exit(n < 3 ? 1 : 0);`,
      ),
      server: longRunning(trace, "server"),
      migrationRetryMs: [10],
      signals: signals as unknown as NodeJS.Process,
    });
    await waitFor(async () => (await lines(trace)).includes("server:start"));
    signals.emit("SIGTERM");
    assert.equal(await done, 0);
    const trail = await lines(trace);
    assert.equal(trail.filter((line) => line === "keeper:start").length, 1);
    assert.equal(trail.filter((line) => line === "migrate").length, 3);
    assert.ok(trail.indexOf("migrate") < trail.indexOf("keeper:start"));
    assert.ok(trail.indexOf("keeper:start") < trail.indexOf("server:start"));
    assert.ok(trail.includes("server:stop") && trail.includes("keeper:stop"));
    assert.deepEqual(
      events().map((line) => line.event),
      ["start.keeper", "start.migration_failed", "start.migration_failed", "start.stopping"],
    );
    assert.equal(events()[0]?.mode, "embedded");
  });
});

test("a crashed server ends the container with its exit code after stopping the keeper", async () => {
  await withRun(async (trace, events) => {
    const code = await supervise({
      keeper: longRunning(trace, "keeper"),
      migrate: script("process.exit(0)"),
      server: script(`${recorder(trace, "server:start")} setTimeout(() => process.exit(3), 300);`),
      signals: new EventEmitter() as unknown as NodeJS.Process,
    });
    assert.equal(code, 3);
    assert.ok((await lines(trace)).includes("keeper:stop"));
    assert.equal(events().at(-1)?.event, "start.server_exited");
  });
});

test("a keeper that exits is started again with a delay", async () => {
  await withRun(async (trace, events) => {
    const signals = new EventEmitter();
    const done = supervise({
      keeper: script(`${recorder(trace, "keeper:start")} process.exit(1);`),
      migrate: script("process.exit(0)"),
      server: longRunning(trace, "server"),
      keeperRestartMs: [10],
      signals: signals as unknown as NodeJS.Process,
    });
    await waitFor(async () => (await lines(trace)).filter((line) => line === "keeper:start").length >= 3);
    signals.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.ok(events().filter((line) => line.event === "start.keeper_exited").length >= 2);
  });
});

test("a stop during the migration lets it finish and never starts the server", async () => {
  await withRun(async (trace) => {
    const signals = new EventEmitter();
    const done = supervise({
      keeper: null,
      migrate: script(`setTimeout(() => { ${recorder(trace, "migrate:done")} process.exit(0); }, 300);`),
      server: longRunning(trace, "server"),
      signals: signals as unknown as NodeJS.Process,
    });
    await sleep(100);
    signals.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.deepEqual(await lines(trace), ["migrate:done"]);
  });
});

test("a stop during a failing migration does not wait for the next attempt", async () => {
  await withRun(async (trace) => {
    const signals = new EventEmitter();
    const startedAt = Date.now();
    const done = supervise({
      keeper: null,
      migrate: script(`setTimeout(() => { ${recorder(trace, "migrate:failed")} process.exit(1); }, 300);`),
      server: longRunning(trace, "server"),
      migrationRetryMs: [60_000],
      signals: signals as unknown as NodeJS.Process,
    });
    await sleep(100);
    signals.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.ok(Date.now() - startedAt < 10_000);
    assert.deepEqual(await lines(trace), ["migrate:failed"]);
  });
});
