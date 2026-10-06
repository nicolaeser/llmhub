import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION = "prisma/migrations/20261006000000_init/migration.sql";

const REQUEST_LOG_COLUMNS = [
  "orgId",
  "projectId",
  "promptTokens",
  "completionTokens",
  "cost",
] as const;

const SPEND_RESET_TABLES = [
  "VirtualKey",
  "Team",
  "Organization",
  "Project",
] as const;

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

function modelBlock(schema: string, name: string) {
  const start = schema.indexOf(`model ${name} {`);
  assert.notEqual(start, -1, `missing model ${name}`);
  const end = schema.indexOf("\n}", start);
  assert.notEqual(end, -1, `unclosed model ${name}`);
  return schema.slice(start, end + 2);
}

function prismaFields(block: string) {
  return [...block.matchAll(/^\s+([A-Za-z_]\w*)\s+/gm)].map(
    (match) => match[1],
  );
}

function createTable(sql: string, table: string) {
  const start = sql.indexOf(`CREATE TABLE "${table}"`);
  assert.notEqual(start, -1, `missing CREATE TABLE ${table}`);
  const end = sql.indexOf(");", start);
  assert.notEqual(end, -1, `unclosed CREATE TABLE ${table}`);
  return sql.slice(start, end + 2);
}

function sqlTableColumns(block: string) {
  const open = block.indexOf("(");
  const close = block.lastIndexOf(")");
  return [...block.slice(open + 1, close).matchAll(/^\s+"(\w+)"/gm)].map(
    (match) => match[1],
  );
}

function columnLine(sql: string, table: string, column: string) {
  const block = createTable(sql, table);
  const line = block.split("\n").find((row) => row.trim().startsWith(`"${column}"`));
  assert.ok(line, `${table}.${column} missing from SQL`);
  return line.trim();
}

test("init migration creates RequestLog dimensions, the usage rollup, and spendResetAt", async () => {
  const sql = await file(MIGRATION);

  assert.equal(columnLine(sql, "RequestLog", "orgId"), `"orgId" TEXT NOT NULL DEFAULT '',`);
  assert.equal(columnLine(sql, "RequestLog", "projectId"), `"projectId" TEXT NOT NULL DEFAULT '',`);
  assert.equal(columnLine(sql, "RequestLog", "promptTokens"), `"promptTokens" INTEGER NOT NULL DEFAULT 0,`);
  assert.equal(columnLine(sql, "RequestLog", "completionTokens"), `"completionTokens" INTEGER NOT NULL DEFAULT 0,`);
  assert.equal(columnLine(sql, "RequestLog", "cost"), `"cost" DECIMAL(20,10) NOT NULL DEFAULT 0,`);

  assert.match(sql, /CREATE TABLE "UsageDaily"/);
  assert.match(sql, /CONSTRAINT "UsageDaily_pkey" PRIMARY KEY \("day","keyId","teamId","orgId","projectId","userId","model"\)/);
  assert.doesNotMatch(sql, /AlertDelivery|CatalogItem|UserAuditLog/);

  for (const table of SPEND_RESET_TABLES) {
    assert.equal(columnLine(sql, table, "spendResetAt"), `"spendResetAt" TIMESTAMP(3),`);
  }
  assert.doesNotMatch(sql, /^--/m);
});

test("spend and audit retention stay in enterprise settings JSON, not SQL", async () => {
  const [sql, settings] = await Promise.all([
    file(MIGRATION),
    file("src/lib/gateway/settings.ts"),
  ]);
  assert.doesNotMatch(
    sql,
    /spend_retention|audit_retention|spendRetention|auditRetention/,
  );
  assert.match(settings, /spend_retention_days:/);
  assert.match(settings, /audit_retention_days:/);
});

test("prisma models match the enterprise ops SQL", async () => {
  const [sql, gateway] = await Promise.all([
    file(MIGRATION),
    file("prisma/schema/gateway.prisma"),
  ]);
  const schemaByTable = {
    Organization: gateway,
    Team: gateway,
    Project: gateway,
    VirtualKey: gateway,
    RequestLog: gateway,
  } as const;

  const requestLog = modelBlock(gateway, "RequestLog");
  const requestFields = prismaFields(requestLog);
  for (const field of REQUEST_LOG_COLUMNS) {
    assert.equal(requestFields.includes(field), true, field);
  }
  assert.match(requestLog, /orgId\s+String\s+@default\(""\)/);
  assert.match(requestLog, /projectId\s+String\s+@default\(""\)/);
  assert.match(requestLog, /promptTokens\s+Int\s+@default\(0\)/);
  assert.match(requestLog, /completionTokens\s+Int\s+@default\(0\)/);
  assert.match(requestLog, /cost\s+Decimal\s+@default\(0\) @db\.Decimal\(20, 10\)/);
  assert.match(requestLog, /@@index\(\[orgId\]\)/);
  assert.match(requestLog, /@@index\(\[projectId\]\)/);


  for (const table of SPEND_RESET_TABLES) {
    const block = modelBlock(schemaByTable[table], table);
    assert.equal(prismaFields(block).includes("spendResetAt"), true, table);
    assert.match(block, /spendResetAt\s+DateTime\?/);
  }

  for (const [table, schema] of Object.entries(schemaByTable)) {
    const fields = prismaFields(modelBlock(schema, table));
    for (const column of sqlTableColumns(createTable(sql, table))) {
      assert.equal(fields.includes(column), true, `${table}.${column} missing from prisma`);
    }
  }
});
