import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATABASE_CONNECT_ATTEMPTS = 10;
const DATABASE_CONNECT_DELAY_MS = 3_000;
const RETRYABLE = /\bP(?:1001|1002|1017)\b/;

export function migrationFailureHelp(output) {
  if (/\bP3005\b/.test(output)) {
    return "The database is not empty and has no migration history. No automatic baseline is performed. Back it up, verify its schema and migration history, then follow the README adoption procedure before restarting.";
  }
  if (/\bP3009\b|\bP3018\b/.test(output)) {
    return "A migration failed. The database and its migration records have been left unchanged by the startup wrapper. Inspect the failure, recover it with Prisma migrate resolve as documented in the README, then restart. The web server will not start before migrate deploy succeeds.";
  }
  return "Database migrations failed; the web server cannot start.";
}

export function validateMigrationEnv(env) {
  if (!["development", "production"].includes(env.NODE_ENV?.trim())) {
    throw new Error("NODE_ENV must be development or production");
  }
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  if ((env.APP_SECRET?.trim().length ?? 0) < 32) throw new Error("APP_SECRET must be at least 32 characters");
}

function runPrisma(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./node_modules/prisma/build/index.js", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-65_536);
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

export async function migrateDatabase({
  env = process.env,
  run = runPrisma,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write = (message) => console.log(message),
  attempts = DATABASE_CONNECT_ATTEMPTS,
  delayMs = DATABASE_CONNECT_DELAY_MS,
} = {}) {
  validateMigrationEnv(env);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run(["migrate", "deploy"], env);
    if (result.output) write(result.output.trimEnd());
    if (result.code === 0) return;
    if (RETRYABLE.test(result.output) && attempt < attempts) {
      write(`[migrate] database not ready, retrying (${attempt}/${attempts})`);
      await wait(delayMs);
      continue;
    }
    throw new Error(migrationFailureHelp(result.output));
  }
  throw new Error("Database migration attempts exhausted");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  migrateDatabase().catch((error) => {
    console.error(`[migrate] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
