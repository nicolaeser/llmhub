import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
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

test("migration SQL carries no comments", async () => {
  for (const folder of await migrationFolders()) {
    const sql = await readFile(path.join(MIGRATIONS, folder, "migration.sql"), "utf8");
    assert.doesNotMatch(sql, /^\s*--/m, folder);
  }
});
