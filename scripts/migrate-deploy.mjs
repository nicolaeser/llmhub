import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;
const DATABASE_CONNECT_ATTEMPTS = 30;
const DATABASE_CONNECT_DELAY_MS = 2_000;
const LOCK_KEY = 4_211_337;
const PRISMA_MIGRATE_LOCK_KEY = 72_707_369;
const MIGRATIONS_DIR = "prisma/migrations";
const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+$/;
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|ABORT|SAVEPOINT|RELEASE)\b/i;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g;
const FAILURE_LOG_LINES = 6;
const PRISMA_LOG_NOISE = /^\s*(A migration failed to apply|Migration name:|DbError|Read more|at |with |\d+: )/;

export const ATOMIC_MIGRATIONS_AFTER = "20261110120000";

export function isAtomicMigrationName(name) {
  const timestamp = MIGRATION_NAME.exec(name)?.[1];
  return Boolean(timestamp) && timestamp > ATOMIC_MIGRATIONS_AFTER;
}

function topLevelLines(sql) {
  const lines = [];
  let openQuote = null;
  for (const raw of sql.split("\n")) {
    const line = raw.trim();
    const insideBody = openQuote !== null;
    for (const [quote] of line.matchAll(DOLLAR_QUOTE)) {
      if (openQuote === null) openQuote = quote;
      else if (quote === openQuote) openQuote = null;
    }
    if (!insideBody && line && !line.startsWith("--")) lines.push(line);
  }
  return lines;
}

export function isTransactionalSql(sql) {
  const lines = topLevelLines(sql);
  if (lines.length < 3) return false;
  if (!/^BEGIN\s*;$/i.test(lines[0]) || !/^COMMIT\s*;$/i.test(lines.at(-1))) return false;
  const statements = lines.flatMap((line) => line.split(";").map((part) => part.trim()).filter(Boolean));
  return !statements.slice(1, -1).some((statement) => TRANSACTION_CONTROL.test(statement));
}

export function classifyFailedMigrations(rows, localSql) {
  const retry = [];
  const blocked = [];
  for (const row of rows) {
    const sql = localSql.get(row.migration_name);
    const atomic = sql === undefined ? isAtomicMigrationName(row.migration_name) : isTransactionalSql(sql);
    (atomic ? retry : blocked).push(row);
  }
  return { retry, blocked };
}

function schemaOf(databaseUrl) {
  try {
    return new URL(databaseUrl).searchParams.get("schema")?.trim() || "public";
  } catch {
    return "public";
  }
}

export function migrationsTable(databaseUrl) {
  return `"${schemaOf(databaseUrl).replaceAll('"', '""')}"."_prisma_migrations"`;
}

export function failureReason(logs) {
  return String(logs ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !PRISMA_LOG_NOISE.test(line))
    .slice(0, FAILURE_LOG_LINES);
}

function runPrisma(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["./node_modules/prisma/build/index.js", ...args],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(code);
        return;
      }
      reject(new Error(`prisma ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function waitForDatabase(pool) {
  for (let attempt = 1; attempt <= DATABASE_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === DATABASE_CONNECT_ATTEMPTS) {
        throw new Error("database did not become ready before migration", { cause: error });
      }
      console.log(`[migrate] waiting for database (${attempt}/${DATABASE_CONNECT_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, DATABASE_CONNECT_DELAY_MS));
    }
  }
}

async function localMigrationSql(names) {
  const entries = await Promise.all(
    names
      .filter((name) => MIGRATION_NAME.test(name))
      .map(async (name) => {
        const sql = await readFile(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8").catch(() => undefined);
        return [name, sql];
      }),
  );
  return new Map(entries.filter(([, sql]) => sql !== undefined));
}

async function failedMigrationRows(client, table) {
  const exists = await client.query("SELECT to_regclass($1) AS name", [table]);
  if (!exists.rows[0]?.name) return [];
  const result = await client.query(
    `SELECT migration_name, started_at, logs FROM ${table} WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at`,
  );
  return result.rows;
}

function printReason(row) {
  const reason = failureReason(row.logs);
  if (!reason.length) {
    console.error("[migrate]   Prisma recorded no reason; Postgres logged it (docker compose logs postgres)");
    return;
  }
  for (const line of reason) console.error(`[migrate]   ${line}`);
}

async function releaseFailedMigrations(client, table) {
  const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [PRISMA_MIGRATE_LOCK_KEY]);
  if (!lock.rows[0]?.locked) {
    console.log("[migrate] another prisma migrate run holds the migration lock; failed migrations stay as they are");
    return [];
  }
  try {
    const rows = await failedMigrationRows(client, table);
    if (!rows.length) return [];
    const { retry, blocked } = classifyFailedMigrations(rows, await localMigrationSql(rows.map((row) => row.migration_name)));
    for (const row of retry) {
      await client.query(
        `UPDATE ${table} SET rolled_back_at = now() WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
        [row.migration_name],
      );
      console.error(`[migrate] ${row.migration_name} failed inside its transaction, so none of it was applied and it can run again`);
      printReason(row);
    }
    return blocked;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [PRISMA_MIGRATE_LOCK_KEY]);
  }
}

function reportBlocked(blocked) {
  for (const row of blocked) {
    const startedAt = row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at);
    console.error(`[migrate] ${row.migration_name} failed at ${startedAt} outside a transaction, so part of it may be applied`);
    printReason(row);
  }
  console.error(
    "[migrate] Undo what the failed migration applied, then mark it rolled back (README, \"A migration failed\"); the next start applies it again",
  );
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const NODE_ENVS = ["development", "production"];

function validateStartupEnv() {
  if (!NODE_ENVS.includes(required("NODE_ENV"))) {
    throw new Error(`NODE_ENV must be ${NODE_ENVS.join(" or ")}`);
  }
  required("DATABASE_URL");
  if (required("APP_SECRET").length < 32) {
    throw new Error("APP_SECRET must be at least 32 characters");
  }
}

async function main() {
  validateStartupEnv();
  const table = migrationsTable(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    await waitForDatabase(pool);
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      const blocked = await releaseFailedMigrations(client, table);
      if (blocked.length) {
        reportBlocked(blocked);
        throw new Error("a failed migration blocks the start");
      }
      try {
        await runPrisma(["migrate", "deploy"]);
      } catch (error) {
        const stillBlocked = await releaseFailedMigrations(client, table).catch((releaseError) => {
          console.error(`[migrate] could not release the failed migration: ${releaseError instanceof Error ? releaseError.message : releaseError}`);
          return [];
        });
        if (stillBlocked.length) reportBlocked(stillBlocked);
        throw error;
      }
      await runPrisma(["migrate", "status"]);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[migrate] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
