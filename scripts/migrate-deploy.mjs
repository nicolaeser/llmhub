import { runPrisma, validateMigrationEnv } from "./prisma-runner.mjs";
import { recoverCompatibility } from "./recover-compatibility.mjs";
export { runPrisma, validateMigrationEnv } from "./prisma-runner.mjs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { pathToFileURL } from "node:url";

const DATABASE_CONNECT_ATTEMPTS = 10;
const DATABASE_CONNECT_DELAY_MS = 3_000;
const RETRYABLE = /\bP(?:1001|1002|1017)\b/;
const CONCURRENT_SCHEMA_CREATION = /\bP2002\b[^\n]*`nspname`/;

export function migrationFailureHelp(output) {
  if (/\bP3005\b/.test(output)) {
    return "The database is not empty and has no migration history. No automatic baseline is performed. Back it up, verify its schema and migration history, then follow the README adoption procedure before restarting.";
  }
  if (/\bP3009\b|\bP3018\b/.test(output)) {
    return "A migration failed. Startup can retry only the verified, fully rolled-back 20261115145000_prisma_compatibility migration. Other failures require investigation: stop the app and updater, back up the database, and follow the README recovery procedure before using Prisma migrate resolve. The web server will not start before migrate deploy succeeds.";
  }
  return "Database migrations failed; the web server cannot start.";
}

export async function migrateDatabase({
  env = process.env,
  run = runPrisma,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write = (message) => console.log(message),
  attempts = DATABASE_CONNECT_ATTEMPTS,
  delayMs = DATABASE_CONNECT_DELAY_MS,
  onStatus = (status) => { void status; },
  recover = run === runPrisma ? recoverCompatibility : null,
} = {}) {
  validateMigrationEnv(env);
  let schemaChanged = "unknown";
  let recoveryAttempted = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let streamed = false;
    let outputTail = "";
    const heartbeat = setInterval(() => write("[migrate] Still running. Large content copies can take time; keep PostgreSQL running and automatic updates paused."), 30_000);
    heartbeat.unref();
    let result;
    try {
      result = await run(["migrate", "deploy"], env, (chunk) => {
        streamed = true;
        outputTail = (outputTail + chunk).slice(-4096);
        if (/Applying migration\b|The following migration\(s\) have been applied/.test(outputTail) && schemaChanged !== true) {
          schemaChanged = true;
          onStatus({ schemaChanged });
        }
        write(chunk.trimEnd());
      });
    } finally {
      clearInterval(heartbeat);
    }
    if (!streamed && result.output) write(result.output.trimEnd());
    if (/Applying migration\b|The following migration\(s\) have been applied/.test(result.output)) schemaChanged = true;
    else if (result.code === 0 && /No pending migrations to apply\./.test(result.output) && schemaChanged !== true && attempt === 1) schemaChanged = false;
    onStatus({ schemaChanged });
    if (result.code === 0) return { schemaChanged };
    if (/\bP3009\b/.test(result.output) && recover && !recoveryAttempted && attempt < attempts) {
      recoveryAttempted = true;
      write("[migrate] Checking whether the published transactional compatibility migration can be safely retried.");
      await recover({ env, write, automatic: true });
      await wait(delayMs);
      continue;
    }
    if (CONCURRENT_SCHEMA_CREATION.test(result.output) && attempt < attempts) {
      write(`[migrate] another start created the database schema at the same time, retrying (${attempt}/${attempts})`);
      await wait(delayMs);
      continue;
    }
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
  migrateDatabase({ onStatus: (status) => process.send?.({ type: "migration_status", ...status }) }).catch((error) => {
    console.error(`[migrate] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
