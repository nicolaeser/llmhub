import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function exportedAsyncFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test("loadUsageAction accepts tenant filters, uses seesAllSpend, and returns rollups", async () => {
  const source = await readFile(
    new URL("../src/app/(app)/_action.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /seesAllSpend/);
  const fn = exportedAsyncFn(source, "loadUsageAction");
  assert.match(fn, /teamId\?: string/);
  assert.match(fn, /orgId\?: string/);
  assert.match(fn, /projectId\?: string/);
  assert.match(fn, /keyId\?: string/);
  assert.match(fn, /userId\?: string/);
  assert.match(fn, /seesAllSpend\(session\)/);
  assert.match(fn, /\.\.\.\(teamId \? \{ teamId \} : \{\}\)/);
  assert.match(fn, /\.\.\.\(orgId \? \{ orgId \} : \{\}\)/);
  assert.match(fn, /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/);
  assert.match(fn, /\.\.\.\(keyId \? \{ keyId \} : \{\}\)/);
  assert.match(fn, /\.\.\.\(userId \? \{ userId \} : \{\}\)/);
  assert.match(fn, /byTeam:/);
  assert.match(fn, /byOrg:/);
  assert.match(fn, /byProject:/);
  assert.match(fn, /byKey:/);
  assert.match(fn, /byUser:/);
  assert.match(fn, /healthByModel:/);
  assert.match(fn, /healthByTeam:/);
  assert.match(fn, /chargeback:/);
  assert.match(fn, /p95Latency:/);
  assert.match(fn, /rate429/);
});
