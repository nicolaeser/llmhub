import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function exportedAsyncFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test("runSpendResets exists and is called from runMaintenanceSweep", async () => {
  const source = await readFile(
    new URL("../src/worker/jobs.ts", import.meta.url),
    "utf8",
  );
  const sweep = exportedAsyncFn(source, "runMaintenanceSweep");
  const reset = exportedAsyncFn(source, "runSpendResets");
  assert.match(
    reset,
    /export async function runSpendResets\([\s\S]*?\): Promise<number>/,
  );
  assert.match(sweep, /await runSpendResets\(now\)/);
});

test("runSpendResets zeros virtualKey, user, team, organization, and project spend", async () => {
  const source = await readFile(
    new URL("../src/worker/jobs.ts", import.meta.url),
    "utf8",
  );
  const reset = exportedAsyncFn(source, "runSpendResets");
  assert.match(reset, /await import\("@\/lib\/gateway\/period"\)/);
  assert.match(
    reset,
    /periodElapsed\(row\.budgetDuration, row\.spendResetAt, now, row\.createdAt\)/,
  );
  assert.match(reset, /const data = \{ spend: 0, spendResetAt: now \}/);
  for (const model of [
    "virtualKey",
    "user",
    "team",
    "organization",
    "project",
  ] as const) {
    assert.match(reset, new RegExp(`prisma\\.${model}\\.findMany`));
    assert.match(
      reset,
      new RegExp(
        `prisma\\.${model}\\.update\\(\\{ where: \\{ id: row\\.id \\}, data \\}`,
      ),
    );
  }
});

test("runBudgetAlerts includes projects", async () => {
  const source = await readFile(
    new URL("../src/worker/jobs.ts", import.meta.url),
    "utf8",
  );
  const alerts = exportedAsyncFn(source, "runBudgetAlerts");
  assert.match(alerts, /prisma\.project\.findMany/);
  assert.match(alerts, /\.\.\.projects\.map/);
  assert.match(alerts, /kind: "project"/);
});
