import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { COMPATIBILITY_MIGRATION, CONTENT_SIZE_MIGRATION, LEGACY_MIGRATIONS } from "../support/migration-history";
import { PRISMA_MIGRATION_LOCK } from "../../../scripts/recover-compatibility.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrations = path.join(root, "prisma/migrations");
const legacy = Object.keys(LEGACY_MIGRATIONS).sort();
const cli = path.join(root, "node_modules/prisma/build/index.js");
const bridgePath = path.join(migrations, COMPATIBILITY_MIGRATION, "migration.sql");
const timeout = 1_200_000;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

type Database = { name: string; url: string; schema: string };

async function harness(t: test.TestContext) {
  const raw = process.env.MIGRATION_TEST_DATABASE_URL;
  assert.ok(raw, "MIGRATION_TEST_DATABASE_URL must point to a disposable local PostgreSQL server");
  const base = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "migration tests require loopback PostgreSQL");
  assert.equal(process.env.NODE_ENV, "development");
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  const prefix = `llmhub_upgrade_${randomBytes(6).toString("hex")}`;
  const databases = new Set<string>();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "llmhub-migration-"));
  const reader = `${prefix}_reader`;
  await admin.query(`CREATE ROLE ${identifier(reader)}`);
  t.after(async () => {
    for (const name of databases) await admin.query(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${identifier(reader)}`);
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  });
  let counter = 0;
  async function create(template?: Database, schema = "public"): Promise<Database> {
    const name = `${prefix}_${counter++}_dev`;
    await admin.query(`CREATE DATABASE ${identifier(name)}${template ? ` TEMPLATE ${identifier(template.name)}` : ""}`);
    databases.add(name);
    const url = new URL(base);
    url.pathname = `/${name}`;
    url.search = "";
    if (schema !== "public") url.searchParams.set("schema", schema);
    return { name, url: url.toString(), schema };
  }
  async function drop(database: Database) {
    assert.ok(databases.has(database.name));
    await admin.query(`DROP DATABASE ${identifier(database.name)} WITH (FORCE)`);
    databases.delete(database.name);
  }
  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(database: Database, sql: string, values: unknown[] = []) {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${identifier(database.schema)}`);
      return await client.query<T>(sql, values);
    } finally {
      await client.end();
    }
  }
  function environment(database: Database) {
    return { ...process.env, NODE_ENV: "development" as const, DATABASE_URL: database.url,
      APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa" };
  }
  async function prisma(database: Database, args: string[], config?: string) {
    return execute(process.execPath, [cli, ...args, ...(config ? ["--config", config] : [])], {
      cwd: root, env: environment(database), maxBuffer: 8 * 1024 ** 2,
    });
  }
  async function boot(database: Database) {
    return execute(process.execPath, [path.join(root, "scripts/migrate-deploy.mjs")], {
      cwd: root, env: environment(database), maxBuffer: 8 * 1024 ** 2,
    });
  }
  async function recover(database: Database) {
    return execute(process.execPath, [path.join(root, "scripts/recover-compatibility.mjs")], {
      cwd: root, env: environment(database), maxBuffer: 8 * 1024 ** 2,
    });
  }
  async function config(names: string[], suffix: string) {
    const folder = path.join(temporary, suffix);
    const migrationPath = path.join(folder, "migrations");
    await mkdir(migrationPath, { recursive: true });
    await cp(path.join(migrations, "migration_lock.toml"), path.join(migrationPath, "migration_lock.toml"));
    for (const name of names) await cp(path.join(migrations, name), path.join(migrationPath, name), { recursive: true });
    const file = path.join(folder, "prisma.config.ts");
    await writeFile(file, `import { defineConfig } from ${JSON.stringify(path.join(root, "node_modules/prisma/config.js"))};\nexport default defineConfig({schema:${JSON.stringify(path.join(root, "prisma/schema"))},migrations:{path:${JSON.stringify(migrationPath)}},datasource:{url:process.env.DATABASE_URL}});\n`);
    return { file, migrationPath };
  }
  return { create, drop, query, prisma, boot, recover, config, reader };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function coreFixture(h: Harness, database: Database) {
  await h.query(database, `
    INSERT INTO "Role" ("id", "name", "permissions", "updatedAt") VALUES ('upgrade-role', 'Upgrade role', ARRAY['logs:read'], now());
    INSERT INTO "User" ("id", "username", "email", "password", "isOwner", "roleId", "updatedAt")
    VALUES ('upgrade-owner', 'upgrade-owner', 'upgrade@example.test', 'opaque-password-hash', true, 'upgrade-role', now());
    INSERT INTO "Session" ("id", "tokenHash", "userId", "secondFactor", "expiresAt")
    VALUES ('upgrade-session', 'opaque-session-hash', 'upgrade-owner', 'TOTP', '2100-01-01');
    INSERT INTO "Setting" ("key", "value") VALUES ('upgrade-marker', '{"preserve":true}');
    INSERT INTO "Organization" ("id", "alias", "spend") VALUES ('upgrade-company', 'Upgrade company', 12.345);
    INSERT INTO "VirtualKey" ("id", "hash", "prefix", "userId") VALUES ('upgrade-key', 'opaque-key-hash', 'test-key', 'upgrade-owner');
    INSERT INTO "ProviderConnection" ("id", "name", "kind", "apiKey", "updatedAt")
    VALUES ('upgrade-provider', 'Upgrade provider', 'openai', 'opaque-sealed-credential', now());
    INSERT INTO "RequestLog" ("id", "keyId", "userId", "cost", "createdAt")
    VALUES ('upgrade-old-log', 'upgrade-key', 'upgrade-owner', 0.123456789, '2020-01-01');
  `);
}

async function contentFixture(h: Harness, database: Database) {
  await h.query(database, `
    INSERT INTO "RequestLogContent" ("logId", "request", "response", "truncated", "createdAt")
    VALUES ('upgrade-old-log', '{"text":"Grüße 🌍","nested":{"null":null,"array":[1,true]}}', NULL, true, '2020-01-01');
  `);
}

async function partitionFixture(h: Harness, database: Database) {
  await h.query(database, `
    GRANT SELECT ON "RequestLogContent" TO ${identifier(h.reader)};
    GRANT UPDATE ("truncated") ON "RequestLogContent" TO ${identifier(h.reader)} WITH GRANT OPTION;
    CREATE TABLE "RequestLogContent_p21000101" PARTITION OF "RequestLogContent" FOR VALUES FROM ('2100-01-01') TO ('2100-01-02');
    INSERT INTO "RequestLog" ("id", "createdAt") VALUES ('upgrade-daily-log', '2100-01-01'), ('upgrade-default-log', '2100-02-01');
    INSERT INTO "RequestLogContent" ("logId", "request", "response", "createdAt") VALUES
      ('upgrade-daily-log', '{"source":"daily"}', 'null', '2100-01-01'),
      ('upgrade-default-log', NULL, '{"source":"default"}', '2100-02-01');
  `);
}

async function snapshot(h: Harness, database: Database) {
  const core = await h.query(database, `SELECT
    (SELECT jsonb_agg(x) FROM (SELECT "id", "username", "email", "password", "isOwner", "roleId" FROM "User" ORDER BY "id") x) AS users,
    (SELECT jsonb_agg(x) FROM (SELECT "id", "tokenHash", "userId", "secondFactor", "expiresAt" FROM "Session" ORDER BY "id") x) AS sessions,
    (SELECT jsonb_agg(x) FROM (SELECT "id", "hash", "prefix" FROM "VirtualKey" ORDER BY "id") x) AS keys,
    (SELECT jsonb_agg(x) FROM (SELECT "id", "apiKey" FROM "ProviderConnection" ORDER BY "id") x) AS providers,
    (SELECT "value" FROM "Setting" WHERE "key" = 'upgrade-marker') AS settings,
    (SELECT "spend"::text FROM "Organization" WHERE "id" = 'upgrade-company') AS spend,
    (SELECT jsonb_agg(x) FROM (SELECT "id", "cost", "createdAt" FROM "RequestLog" ORDER BY "id") x) AS logs`);
  const exists = await h.query(database, `SELECT to_regclass('"RequestLogContent"') AS relation`);
  const contents = exists.rows[0].relation ? (await h.query(database, `SELECT "logId", "createdAt", "request", "response",
    "request" IS NULL AS "requestSqlNull", "response" IS NULL AS "responseSqlNull", "truncated"
    FROM "RequestLogContent" ORDER BY "logId", "createdAt"`)).rows : null;
  return { core: core.rows[0], contents };
}

async function assertCurrent(h: Harness, database: Database) {
  assert.equal((await h.query(database, `SELECT relkind FROM pg_class WHERE oid = '"RequestLogContent"'::regclass`)).rows[0].relkind, "r");
  assert.equal((await h.query(database, `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = '"RequestLogContent"'::regclass`)).rows[0].n, 0);
  assert.equal((await h.query(database, `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"PolicyOverride"'::regclass AND contype = 'c'`)).rows[0].n, 0);
  const history = await h.query(database, `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
  const folders = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(history.rows.map((row) => row.migration_name), folders);
  for (const row of history.rows.filter((row) => row.migration_name in LEGACY_MIGRATIONS)) {
    assert.equal(row.checksum, LEGACY_MIGRATIONS[row.migration_name]);
  }
}

test("every published migration prefix upgrades without changing operators, credentials, settings, usage, or content", { timeout, concurrency: 3 }, async (t) => {
  const h = await harness(t);
  const source = await h.create();
  const prefix = await h.config([], "prefix");
  const pending: Promise<void>[] = [];
  for (const name of legacy) {
    await cp(path.join(migrations, name), path.join(prefix.migrationPath, name), { recursive: true });
    await h.prisma(source, ["migrate", "deploy"], prefix.file);
    if (name === legacy[0]) await coreFixture(h, source);
    if (name === "20261006120000_request_log_content") await contentFixture(h, source);
    if (name === "20261111120000_request_content_partitions") await partitionFixture(h, source);
    const before = await snapshot(h, source);
    const upgraded = await h.create(source);
    pending.push(t.test(name, async () => {
      try {
        await h.boot(upgraded);
        await assertCurrent(h, upgraded);
        const after = await snapshot(h, upgraded);
        assert.deepEqual(after.core, before.core);
        assert.deepEqual(after.contents, before.contents ?? []);
        if (name >= "20261111120000_request_content_partitions") {
          const granted = await h.query(upgraded, `SELECT has_table_privilege($1, '"RequestLogContent"', 'SELECT') AS readable,
            has_column_privilege($1, '"RequestLogContent"', 'truncated', 'UPDATE WITH GRANT OPTION') AS writable`, [h.reader]);
          assert.deepEqual(granted.rows[0], { readable: true, writable: true });
        }
        await h.query(upgraded, `INSERT INTO "RequestLogContent" ("logId", "request", "createdAt")
          VALUES ('upgrade-old-log', '{"oldClient":true}', '2101-01-01')`);
        assert.equal((await h.query(upgraded, `SELECT "sizeBytes" FROM "RequestLogContent" WHERE "createdAt" = '2101-01-01'`)).rows[0].sizeBytes, null);
      } finally {
        await h.drop(upgraded);
      }
    }));
  }
  await Promise.all(pending);
});

test("fresh and non-public schemas migrate concurrently and repeated starts have no drift", { timeout }, async (t) => {
  const h = await harness(t);
  for (const schema of ["public", "hub"]) {
    const database = await h.create(undefined, schema);
    await Promise.all([h.boot(database), h.boot(database)]);
    await assertCurrent(h, database);
    const before = (await h.query(database, `SELECT * FROM "_prisma_migrations" ORDER BY migration_name`)).rows;
    await h.boot(database);
    assert.deepEqual((await h.query(database, `SELECT * FROM "_prisma_migrations" ORDER BY migration_name`)).rows, before);
    await h.prisma(database, ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema", "--exit-code"]);
  }
});

test("the regular migration is exactly Prisma output from the compatibility schema", { timeout }, async (t) => {
  if ((await readdir(migrations)).some((name) => /^\d{14}_/.test(name) && name > CONTENT_SIZE_MIGRATION)) {
    return t.skip("Later migrations changed the schema beyond this generated migration");
  }
  const h = await harness(t);
  const database = await h.create();
  const throughBridge = await h.config([...legacy, COMPATIBILITY_MIGRATION], "before-generated");
  await h.prisma(database, ["migrate", "deploy"], throughBridge.file);
  const generated = await h.prisma(database, ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema", "--script"]);
  const committed = await readFile(path.join(migrations, CONTENT_SIZE_MIGRATION, "migration.sql"), "utf8");
  assert.equal(generated.stdout, `${committed}\n`);
});

test("a failed compatibility copy rolls back all data and requires explicit Prisma recovery", { timeout }, async (t) => {
  const h = await harness(t);
  const database = await h.create(undefined, "hub");
  const old = await h.config(legacy, "old");
  await h.prisma(database, ["migrate", "deploy"], old.file);
  await coreFixture(h, database);
  await contentFixture(h, database);
  await partitionFixture(h, database);
  await h.query(database, `ALTER TABLE "RequestLogContent" OWNER TO ${identifier(h.reader)}`);
  const before = await snapshot(h, database);
  const broken = await h.config([...legacy, COMPATIBILITY_MIGRATION], "fault");
  await writeFile(path.join(broken.migrationPath, COMPATIBILITY_MIGRATION, "migration.sql"),
    (await readFile(bridgePath, "utf8")).replace("COMMIT;", "SELECT 1 / 0;\nCOMMIT;"));
  await assert.rejects(h.prisma(database, ["migrate", "deploy"], broken.file));
  assert.deepEqual(await snapshot(h, database), before);
  assert.equal((await h.query(database, `SELECT relkind FROM pg_class WHERE oid = '"RequestLogContent"'::regclass`)).rows[0].relkind, "p");
  const failed = (await h.query(database, `SELECT * FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows;
  assert.equal(failed.length, 1);
  await assert.rejects(h.boot(database));
  await assert.rejects(h.recover(database), (error: unknown) => {
    assert.match(String((error as { stderr?: string }).stderr), /published compatibility checksum/);
    return true;
  });
  assert.deepEqual((await h.query(database, `SELECT * FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows, failed);
  await h.prisma(database, ["migrate", "resolve", "--rolled-back", COMPATIBILITY_MIGRATION]);
  await h.boot(database);
  await assertCurrent(h, database);
  assert.deepEqual(await snapshot(h, database), before);
  assert.equal((await h.query(database, `SELECT pg_get_userbyid(relowner) AS owner
    FROM pg_class WHERE oid = '"RequestLogContent"'::regclass`)).rows[0].owner, h.reader);
});

test("explicit recovery verifies an interrupted published migration and preserves all data", { timeout }, async (t) => {
  const h = await harness(t);
  const old = await h.config(legacy, "before-interruption");
  for (const schema of ["public", "hub"]) {
    const database = await h.create(undefined, schema);
    await h.prisma(database, ["migrate", "deploy"], old.file);
    await coreFixture(h, database);
    await contentFixture(h, database);
    await partitionFixture(h, database);
    const before = await snapshot(h, database);
    const blocker = new pg.Client({ connectionString: database.url });
    await blocker.connect();
    try {
      await blocker.query(`BEGIN; LOCK TABLE ${identifier(schema)}."RequestLog" IN ACCESS EXCLUSIVE MODE`);
      const migration = h.boot(database).then(() => null, (error: unknown) => error);
      let pid: number | undefined;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const active = await h.query(database, `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%CREATE TABLE "RequestLogContent_plain"%'`);
        pid = active.rows[0]?.pid;
        if (pid) break;
        await delay(100);
      }
      assert.ok(pid, "the published migration must reach its transactional table lock");
      await assert.rejects(h.recover(database), (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /Another migration is running/);
        return true;
      });
      await h.query(database, "SELECT pg_terminate_backend($1)", [pid]);
      await blocker.query("ROLLBACK");
      assert.ok(await migration, "the interrupted migration must fail");
    } finally {
      await blocker.end();
    }
    assert.deepEqual(await snapshot(h, database), before);
    const failed = (await h.query(database, `SELECT * FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows;
    assert.equal(failed.length, 1);
    await h.query(database, 'CREATE TABLE "RequestLogContent_plain" (id int)');
    await assert.rejects(h.recover(database), (error: unknown) => {
      assert.match(String((error as { stderr?: string }).stderr), /does not match a rolled-back/);
      return true;
    });
    assert.deepEqual((await h.query(database, `SELECT * FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows, failed);
    await h.query(database, 'DROP TABLE "RequestLogContent_plain"');
    await h.recover(database);
    const recovered = (await h.query(database, `SELECT * FROM "_prisma_migrations" WHERE id = $1`, [failed[0].id])).rows[0];
    assert.ok(recovered.rolled_back_at);
    assert.equal(recovered.finished_at, null);
    await assert.rejects(h.recover(database));
    await h.boot(database);
    await assertCurrent(h, database);
    assert.deepEqual(await snapshot(h, database), before);
    const free = new pg.Client({ connectionString: database.url });
    await free.connect();
    try {
      assert.equal((await free.query("SELECT pg_try_advisory_lock($1) AS locked", [PRISMA_MIGRATION_LOCK])).rows[0].locked, true);
    } finally {
      await free.end();
    }
  }
});

test("an unbaselined existing database is refused without altering its data", { timeout }, async (t) => {
  const h = await harness(t);
  const database = await h.create();
  await h.query(database, `CREATE TABLE "preserved" (value text); INSERT INTO "preserved" VALUES ('keep');`);
  await assert.rejects(h.boot(database), (error: unknown) => {
    assert.match(String((error as { stderr?: string }).stderr), /No automatic baseline/);
    return true;
  });
  assert.deepEqual((await h.query(database, `SELECT * FROM "preserved"`)).rows, [{ value: "keep" }]);
});

test("compatibility recovery refuses a partially applied regular migration", { timeout }, async (t) => {
  const h = await harness(t);
  const database = await h.create();
  const broken = await h.config([...legacy, COMPATIBILITY_MIGRATION, CONTENT_SIZE_MIGRATION], "regular-failure");
  const file = path.join(broken.migrationPath, CONTENT_SIZE_MIGRATION, "migration.sql");
  await writeFile(file, `ALTER TABLE "RequestLogContent" ADD COLUMN "partial" TEXT;\n`);
  await h.prisma(database, ["migrate", "deploy"], (await h.config([...legacy, COMPATIBILITY_MIGRATION], "through-bridge")).file);
  await h.query(database, 'ALTER TABLE "RequestLogContent" ADD COLUMN "partial" TEXT');
  await assert.rejects(h.prisma(database, ["migrate", "deploy"], broken.file));
  const before = (await h.query(database, 'SELECT * FROM "_prisma_migrations" ORDER BY started_at')).rows;
  await assert.rejects(h.recover(database), (error: unknown) => {
    assert.match(String((error as { stderr?: string }).stderr), /published compatibility checksum/);
    return true;
  });
  assert.deepEqual((await h.query(database, 'SELECT * FROM "_prisma_migrations" ORDER BY started_at')).rows, before);
  assert.equal((await h.query(database, `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'RequestLogContent' AND column_name = 'partial'`)).rows[0].n, 1);
});
