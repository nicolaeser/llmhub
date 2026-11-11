import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

export const KEEPER_MODE_ENV = "LLMHUB_KEEPER";
export const SEPARATE_KEEPER = "separate";
export const MIGRATION_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
export const KEEPER_RESTART_MS = [5_000, 15_000, 60_000];
export const KEEPER_STABLE_MS = 10 * 60_000;
export const KEEPER_STOP_MS = 25_000;

const NODE = process.execPath;
export const KEEPER_COMMAND = [NODE, ["--liftoff-only", "--wasm-lazy-compilation", "keeper/keeper.mjs"]];
export const MIGRATE_COMMAND = [NODE, ["migrate-deploy.mjs"]];
export const SERVER_COMMAND = [NODE, ["server.js"]];

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export function keeperEmbedded(env = process.env) {
  return String(env[KEEPER_MODE_ENV] ?? "").trim().toLowerCase() !== SEPARATE_KEEPER;
}

export function retryDelay(delays, attempt) {
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
}

function launch([command, args]) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
  });
  return { child, exited };
}

function exitFields(result) {
  return {
    exitCode: result.code,
    signal: result.signal,
    ...(result.error ? { err: result.error.message } : {}),
  };
}

function superviseKeeper(command, { restartMs, stableMs, stopMs }) {
  let current = null;
  let failures = 0;
  let timer;
  let stopping = null;

  const start = () => {
    const startedAt = Date.now();
    const run = launch(command);
    current = run;
    void run.exited.then((result) => {
      current = null;
      if (stopping) return;
      failures = Date.now() - startedAt >= stableMs ? 0 : failures + 1;
      const delay = retryDelay(restartMs, failures - 1);
      log("warn", "start.keeper_exited", { ...exitFields(result), restartInMs: delay });
      timer = setTimeout(start, delay);
    });
  };

  start();
  return {
    stop() {
      stopping ??= (async () => {
        clearTimeout(timer);
        const run = current;
        if (!run) return;
        run.child.kill("SIGTERM");
        const force = setTimeout(() => run.child.kill("SIGKILL"), stopMs);
        await run.exited;
        clearTimeout(force);
      })();
      return stopping;
    },
  };
}

export async function supervise({
  keeper = keeperEmbedded() ? KEEPER_COMMAND : null,
  migrate = MIGRATE_COMMAND,
  server = SERVER_COMMAND,
  migrationRetryMs = MIGRATION_RETRY_MS,
  keeperRestartMs = KEEPER_RESTART_MS,
  keeperStableMs = KEEPER_STABLE_MS,
  keeperStopMs = KEEPER_STOP_MS,
  signals = process,
} = {}) {
  let stopSignal = null;
  let serverChild = null;
  let wake = null;
  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  let keeperRun = null;
  const startKeeper = () => {
    if (keeperRun || stopSignal) return;
    log("info", "start.keeper", { mode: keeper ? "embedded" : SEPARATE_KEEPER });
    keeperRun = keeper
      ? superviseKeeper(keeper, { restartMs: keeperRestartMs, stableMs: keeperStableMs, stopMs: keeperStopMs })
      : { stop: async () => {} };
  };

  const onSignal = (signal) => {
    if (stopSignal) return;
    stopSignal = signal;
    log("info", "start.stopping", { signal });
    wake?.();
    serverChild?.kill(signal);
    void keeperRun?.stop();
  };
  const handlers = [
    ["SIGTERM", () => onSignal("SIGTERM")],
    ["SIGINT", () => onSignal("SIGINT")],
  ];
  for (const [signal, handler] of handlers) signals.on(signal, handler);

  try {
    for (let attempt = 0; ; attempt += 1) {
      if (stopSignal) return 0;
      const result = await launch(migrate).exited;
      startKeeper();
      if (result.code === 0) break;
      const delay = retryDelay(migrationRetryMs, attempt);
      log("error", "start.migration_failed", { attempt: attempt + 1, ...exitFields(result), retryInMs: delay });
      if (stopSignal) return 0;
      await pause(delay);
    }
    if (stopSignal) return 0;
    const run = launch(server);
    serverChild = run.child;
    const result = await run.exited;
    serverChild = null;
    if (stopSignal) return result.code ?? 0;
    log("error", "start.server_exited", exitFields(result));
    return result.code || 1;
  } finally {
    await keeperRun?.stop();
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void supervise().then((code) => {
    process.exitCode = code;
  });
}
