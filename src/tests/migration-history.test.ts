import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrationHistoryProblems, migrationOrderProblems } from "../../scripts/check-migration-order.mjs";
import { COMPATIBILITY_MIGRATION, LEGACY_MIGRATIONS } from "./support/migration-history";

const root = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = path.join(root, "prisma/migrations");
const FOLDER = /^(\d{14})_([a-z0-9_]+)$/;

const APPLIED_SHARED_TIMESTAMPS: Record<string, string[]> = {
  "20261006120000": ["management_keys", "model_templates", "request_log_content", "structure_budgets"],
  "20261009120000": [
    "cache_stats",
    "guardrail_policies",
    "key_access_restrictions",
    "key_max_request_cost",
    "prompt_cache_usage",
    "usage_reports",
    "vector_stores",
  ],
};

async function migrationFolders(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("every migration folder is a timestamp plus a snake_case name with a migration.sql", async () => {
  const folders = await migrationFolders();
  assert.ok(folders.length > 0);
  for (const folder of folders) {
    assert.match(folder, FOLDER, folder);
    const sql = await stat(path.join(MIGRATIONS, folder, "migration.sql"));
    assert.ok(sql.isFile() && sql.size > 0, folder);
  }
});

test("a new migration never reuses an existing timestamp", async () => {
  const byTimestamp = new Map<string, string[]>();
  for (const folder of await migrationFolders()) {
    const [, timestamp, name] = FOLDER.exec(folder) ?? [];
    byTimestamp.set(timestamp, [...(byTimestamp.get(timestamp) ?? []), name]);
  }
  for (const [timestamp, names] of byTimestamp) {
    if (names.length === 1) continue;
    assert.deepEqual(
      names,
      APPLIED_SHARED_TIMESTAMPS[timestamp],
      `${timestamp} is shared by ${names.join(", ")}; give the new migration a later timestamp`,
    );
  }
  for (const [timestamp, names] of Object.entries(APPLIED_SHARED_TIMESTAMPS)) {
    assert.deepEqual(byTimestamp.get(timestamp), names, `applied migrations under ${timestamp} must not be renamed`);
  }
});

test("every migration timestamp is a real UTC date and time", async () => {
  for (const folder of await migrationFolders()) {
    const [, timestamp] = FOLDER.exec(folder) ?? [];
    const [year, month, day, hour, minute, second] = [0, 4, 6, 8, 10, 12].map((start, index) =>
      Number(timestamp.slice(start, start + (index === 0 ? 4 : 2))),
    );
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    assert.equal(date.toISOString().replace(/\D/g, "").slice(0, 14), timestamp, folder);
  }
});

test("the CI order check rejects a new migration that sorts before the base branch's newest one", async () => {
  const base = await migrationFolders();
  const newest = base.at(-1) ?? "";
  const later = `${String(Number(newest.slice(0, 14)) + 1)}_later_change`;
  assert.deepEqual(migrationOrderProblems(base, [...base, later]), []);
  assert.deepEqual(migrationOrderProblems(base, base), []);
  assert.deepEqual(migrationOrderProblems([], ["20261006000000_init"]), []);
  const earlier = "20261006130000_late_branch";
  assert.deepEqual(migrationOrderProblems(base, [...base, earlier]), [
    `${earlier} must use a later timestamp than ${newest}, the newest migration on the base branch`,
  ]);
  const sameTimestamp = `${newest.slice(0, 14)}_zz_same_second`;
  assert.equal(migrationOrderProblems(base, [...base, sameTimestamp]).length, 1);
  const renamed = base.map((folder) => (folder === "20261006000000_init" ? "20261006000000_initial" : folder));
  assert.deepEqual(migrationOrderProblems(base, renamed), [
    "20261006000000_init exists on the base branch and must not be renamed or removed",
    `20261006000000_initial must use a later timestamp than ${newest}, the newest migration on the base branch`,
  ]);
  assert.deepEqual(migrationOrderProblems([...base, "migration_lock.toml"], [...base, "migration_lock.toml"]), []);
});

test("every released migration remains byte-identical and present", async () => {
  assert.equal(Object.keys(LEGACY_MIGRATIONS).length, 63);
  for (const [folder, expected] of Object.entries(LEGACY_MIGRATIONS)) {
    const sql = await readFile(path.join(MIGRATIONS, folder, "migration.sql"));
    assert.equal(createHash("sha256").update(sql).digest("hex"), expected, folder);
  }
});

test("the legacy compatibility bridge is the only new customized migration", async () => {
  const folders = await migrationFolders();
  assert.ok(folders.includes(COMPATIBILITY_MIGRATION));
  const bridge = await readFile(path.join(MIGRATIONS, COMPATIBILITY_MIGRATION, "migration.sql"), "utf8");
  assert.match(bridge, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.doesNotMatch(bridge, /^\s*--/m);
  for (const folder of folders.filter((name) => !(name in LEGACY_MIGRATIONS) && name !== COMPATIBILITY_MIGRATION)) {
    assert.ok(folder > COMPATIBILITY_MIGRATION, folder);
    const sql = await readFile(path.join(MIGRATIONS, folder, "migration.sql"), "utf8");
    assert.doesNotMatch(sql, /\b(?:CREATE\s+(?:EXTENSION|TRIGGER|FUNCTION|VIEW)|CHECK\s*\(|GENERATED\s+ALWAYS|PARTITION\s+BY|COLLATE|INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|BEGIN\s*;|COMMIT\s*;|DO\s+\$)/i, folder);
  }
});


test("the CI history check rejects changed SQL even when folder names are unchanged", () => {
  const name = "20261006000000_init";
  const base = new Map([[name, 'CREATE TABLE "example" (id TEXT);\n']]);
  assert.deepEqual(migrationHistoryProblems(base, new Map(base)), []);
  const changed = new Map([[name, 'CREATE TABLE "example" (id INTEGER);\n']]);
  assert.deepEqual(migrationHistoryProblems(base, changed), [
    `${name} exists on the base branch and its SQL must not change`,
  ]);
});
