import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function exportedAsyncFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test("loadUsageAction accepts tenant filters, applies the spend scope last, and returns rollups", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/_action.ts", import.meta.url),
    "utf8",
  );
  const fn = exportedAsyncFn(source, "loadUsageAction");
  for (const field of ["teamId", "orgId", "projectId", "memberId", "keyId", "userId"]) {
    assert.match(fn, new RegExp(`${field}\\?: string`), field);
    assert.match(fn, new RegExp(`\\.\\.\\.\\(${field} \\? \\{ ${field} \\} : \\{\\}\\)`), field);
  }
  assert.match(fn, /\.\.\.\(userId \? \{ userId \} : \{\}\),\n\s+\.\.\.spendScope\(session\),/);
  for (const group of ["byTeam", "byOrg", "byProject", "byMember", "byKey", "byUser", "healthByModel", "healthByTeam"]) {
    assert.match(fn, new RegExp(`${group}:`), group);
  }
  assert.match(fn, /names: await usageNames\(rows\)/);
  assert.match(fn, /chargeback:/);
  assert.match(fn, /p95Latency:/);
  assert.match(fn, /rate429/);
});
