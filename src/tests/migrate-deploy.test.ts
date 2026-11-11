import assert from "node:assert/strict";
import test from "node:test";
import {
  ATOMIC_MIGRATIONS_AFTER,
  classifyFailedMigrations,
  failureReason,
  isAtomicMigrationName,
  isTransactionalSql,
  migrationsTable,
} from "../../scripts/migrate-deploy.mjs";

const WRAPPED = 'BEGIN;\n\nALTER TABLE "ModelGroup" ADD COLUMN "probe" TEXT;\n\nCOMMIT;\n';
const LATER = `${String(Number(ATOMIC_MIGRATIONS_AFTER) + 1)}_later_change`;
const LEGACY = "20261110120000_model_extra_names";

test("only SQL wrapped in a single BEGIN and COMMIT counts as transactional", () => {
  assert.equal(isTransactionalSql(WRAPPED), true);
  assert.equal(isTransactionalSql(`-- AddColumn\n${WRAPPED}`), true);
  assert.equal(isTransactionalSql("begin ;\nSELECT 1;\ncommit;"), true);
  assert.equal(isTransactionalSql('ALTER TABLE "ModelGroup" ADD COLUMN "probe" TEXT;'), false);
  assert.equal(isTransactionalSql("BEGIN;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nBEGIN;\nSELECT 3;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1;\nROLLBACK;\nSELECT 2;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1;\nEND;\nSELECT 2;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nUPDATE t SET a = 1; COMMIT; BEGIN;\nALTER TABLE t ADD c int;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1; SAVEPOINT s;\nCOMMIT;"), false);
  assert.equal(isTransactionalSql("BEGIN;\nSELECT 1; SELECT 2;\nCOMMIT;"), true);
});

test("PL/pgSQL blocks inside a wrapped migration do not end its transaction", () => {
  const sql = [
    "BEGIN;",
    "DO $$",
    "BEGIN",
    "  BEGIN",
    "    PERFORM 1;",
    "  END;",
    "END $$;",
    "CREATE FUNCTION f() RETURNS void AS $body$",
    "BEGIN;",
    "COMMIT;",
    "$body$ LANGUAGE plpgsql;",
    "COMMIT;",
  ].join("\n");
  assert.equal(isTransactionalSql(sql), true);
});

test("migrations after the cutoff are atomic by name", () => {
  assert.equal(isAtomicMigrationName(LATER), true);
  assert.equal(isAtomicMigrationName(LEGACY), false);
  assert.equal(isAtomicMigrationName("20261006000000_init"), false);
  assert.equal(isAtomicMigrationName("not_a_migration"), false);
});

test("failed migrations are retried only when nothing of them can be applied", () => {
  const row = (name: string) => ({ migration_name: name, started_at: new Date(0), logs: null });
  const local = new Map([
    [LATER, WRAPPED],
    [LEGACY, 'ALTER TABLE "ModelGroup" ADD COLUMN "extraNames" TEXT[];'],
    ["20261103090000_provider_concurrency", WRAPPED],
  ]);
  const unknownNewer = `${String(Number(ATOMIC_MIGRATIONS_AFTER) + 2)}_from_a_newer_image`;
  const unknownOlder = "20261001000000_from_somewhere_else";
  const { retry, blocked } = classifyFailedMigrations(
    [row(LATER), row(LEGACY), row("20261103090000_provider_concurrency"), row(unknownNewer), row(unknownOlder)],
    local,
  );
  assert.deepEqual(
    retry.map((entry) => entry.migration_name),
    [LATER, "20261103090000_provider_concurrency", unknownNewer],
  );
  assert.deepEqual(
    blocked.map((entry) => entry.migration_name),
    [LEGACY, unknownOlder],
  );
});

test("a local migration that lost its transaction is not retried even after the cutoff", () => {
  const { retry, blocked } = classifyFailedMigrations(
    [{ migration_name: LATER, started_at: new Date(0), logs: null }],
    new Map([[LATER, 'ALTER TABLE "ModelGroup" ADD COLUMN "probe" TEXT;']]),
  );
  assert.equal(retry.length, 0);
  assert.equal(blocked.length, 1);
});

test("the failure reason keeps the database error and drops Prisma boilerplate", () => {
  const logs = [
    "A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
    "",
    "Migration name: 20261110120000_model_extra_names",
    "",
    "Database error code: 53100",
    "",
    "Database error:",
    'ERROR: could not extend file "base/16384/16999": No space left on device',
    "",
    'DbError { severity: "ERROR" }',
    "",
    "   0: sql_schema_connector::apply_migration::apply_script",
    '           with migration_name="20261110120000_model_extra_names"',
    "             at schema-engine/connectors/sql-schema-connector/src/apply_migration.rs:113",
  ].join("\n");
  assert.deepEqual(failureReason(logs), [
    "Database error code: 53100",
    "Database error:",
    'ERROR: could not extend file "base/16384/16999": No space left on device',
  ]);
  assert.deepEqual(failureReason(null), []);
});

test("the migrations table follows the schema of the database URL", () => {
  assert.equal(migrationsTable("postgresql://u:p@db:5432/llmhub"), '"public"."_prisma_migrations"');
  assert.equal(migrationsTable("postgresql://u:p@db:5432/llmhub?schema=hub"), '"hub"."_prisma_migrations"');
  assert.equal(migrationsTable('postgresql://u:p@db:5432/llmhub?schema=a"b'), '"a""b"."_prisma_migrations"');
  assert.equal(migrationsTable("not a url"), '"public"."_prisma_migrations"');
});
