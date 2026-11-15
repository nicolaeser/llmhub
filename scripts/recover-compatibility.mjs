import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { runPrisma, validateMigrationEnv } from "./prisma-runner.mjs";

export const COMPATIBILITY_MIGRATION = "20261115145000_prisma_compatibility";
export const COMPATIBILITY_CHECKSUM = "52cabd69feb4f4677cdf1808396254fa19f3c2a039c46a501f85534b3a8feacc";
export const PRISMA_MIGRATION_LOCK = 72707369;

export async function recoverCompatibility({ env = process.env, write = (message) => console.log(message), signal, automatic = false } = {}) {
  validateMigrationEnv(env);
  signal?.throwIfAborted();
  const sql = await readFile(path.join("prisma/migrations", COMPATIBILITY_MIGRATION, "migration.sql"));
  if (createHash("sha256").update(sql).digest("hex") !== COMPATIBILITY_CHECKSUM) {
    throw new Error("The bundled compatibility migration has changed. Recovery refused.");
  }
  const url = new URL(env.DATABASE_URL);
  const schema = url.searchParams.get("schema") ?? "public";
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const connectionLost = (error) => controller.abort(error);
  client.on("error", connectionLost);
  try {
    await client.connect();
    await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
    await client.query("SET statement_timeout = '10s'");
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [PRISMA_MIGRATION_LOCK]);
    if (!lock.rows[0].locked && automatic) return { recovered: false, busy: true };
    if (!lock.rows[0].locked) throw new Error("Another migration is running. Stop the app and updater and wait for it to finish before recovery.");
    const history = (await client.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows;
    const failed = history.filter((row) => row.finished_at === null && row.rolled_back_at === null);
    if (failed.length === 0 && automatic) return { recovered: false, busy: false };
    if (failed.length !== 1 || failed[0].migration_name !== COMPATIBILITY_MIGRATION || failed[0].checksum !== COMPATIBILITY_CHECKSUM) {
      throw new Error("Recovery requires exactly one failed migration with the published compatibility checksum. No migration records were changed.");
    }
    if (history.some((row) => row.migration_name >= COMPATIBILITY_MIGRATION && row.finished_at !== null && row.rolled_back_at === null)) {
      throw new Error("The compatibility migration or a later migration already completed. Recovery refused.");
    }
    const state = (await client.query(`SELECT
      (SELECT relkind FROM pg_class WHERE oid = to_regclass('"RequestLogContent"')) AS kind,
      to_regclass('"RequestLogContent_plain"') IS NULL AS copy_absent,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('"PolicyOverride"')
        AND conname = 'PolicyOverride_one_target' AND contype = 'c') AS policy_check,
      NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('"RequestLogContent"')
        AND attname = 'sizeBytes' AND NOT attisdropped) AS size_absent`)).rows[0];
    if (state.kind !== "p" || !state.copy_absent || !state.policy_check || !state.size_absent) {
      throw new Error("The database does not match a rolled-back compatibility conversion. No migration records were changed.");
    }
    controller.signal.throwIfAborted();
    write("[recover] Verified the published transactional migration and its rolled-back schema. Marking it rolled back through Prisma.");
    const result = await runPrisma(["migrate", "resolve", "--rolled-back", COMPATIBILITY_MIGRATION],
      { ...env, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" }, (chunk) => write(chunk.trimEnd()), controller.signal);
    if (result.code !== 0) throw new Error("Prisma recovery failed. Inspect the output before retrying.");
    controller.signal.throwIfAborted();
    if (automatic) {
      write("[recover] Verified recovery complete; startup will retry migrate deploy.");
      return { recovered: true, busy: false };
    }
    write("[recover] Recovery complete. Run migrate deploy with the app and updater stopped; allow the content copy to finish before restarting them.");
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.length > 2) {
  console.log("Usage: node recover-compatibility.mjs\nStop the app and updater and back up the database before running this explicit repair.");
  process.exitCode = process.argv.length === 3 && process.argv[2] === "--help" ? 0 : 1;
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort(new Error("Recovery interrupted"));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  recoverCompatibility({ signal: controller.signal }).catch((error) => {
    console.error(`[recover] ${error instanceof Error ? error.message : "Recovery failed"}`);
    process.exitCode = 1;
  }).finally(() => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  });
}
