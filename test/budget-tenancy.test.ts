import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capExceeded } from "@/lib/gateway/period";

function exportedAsyncFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test("capExceeded treats 0 as unlimited and extra as headroom", () => {
  assert.equal(capExceeded(100, 0), false);
  assert.equal(capExceeded(12, 10, 5), false);
  assert.equal(capExceeded(15, 10, 5), true);
});

test("assertBudget checks the whole chain: key, user, project, team, and org", async () => {
  const billing = await readFile(
    new URL("../src/lib/gateway/billing.ts", import.meta.url),
    "utf8",
  );
  const fn = exportedAsyncFn(billing, "assertBudget");
  assert.match(fn, /export async function assertBudget\(principal: Principal\): Promise<void>/);
  assert.match(fn, /budgetChain\(principal\)/);
  assert.match(fn, /spendAfterReset\(link\.kind/);
  assert.match(fn, /extraCap\(link\.kind/);
  const chain = billing.slice(billing.indexOf("export function budgetChain"));
  for (const kind of ["key", "user", "project", "team", "org"]) {
    assert.ok(chain.includes(`kind: "${kind}"`), kind);
  }
  assert.doesNotMatch(fn, /modelMaxBudget/);
});

test("recordUsage charges the user budget alongside key, team, org, and project", async () => {
  const billing = await readFile(
    new URL("../src/lib/gateway/billing.ts", import.meta.url),
    "utf8",
  );
  const fn = exportedAsyncFn(billing, "recordUsage");
  for (const model of ["virtualKey", "user", "team", "organization", "project"]) {
    assert.match(fn, new RegExp(`prisma\\.${model}\\.updateMany\\(\\{ where: \\{ id: \\w+ \\}, data: increment \\}\\)`), model);
  }
});

test("period resets only win once under concurrency", async () => {
  const billing = await readFile(
    new URL("../src/lib/gateway/billing.ts", import.meta.url),
    "utf8",
  );
  const start = billing.indexOf("async function spendAfterReset");
  const fn = billing.slice(start, billing.indexOf("\nexport ", start));
  assert.match(fn, /const where = \{ id: row\.id, spendResetAt: row\.spendResetAt \}/);
  assert.doesNotMatch(fn, /\.update\(\{/);
});

test("key principals resolve tenancy live and reject inactive owners", async () => {
  const source = await readFile(
    new URL("../src/lib/gateway/principal.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!row\.user \|\| row\.user\.blocked\) return null;/);
  assert.match(source, /api key owner is not active/);
  assert.match(source, /const bound = project\?\.teamId \?\? input\.teamId;/);
  assert.match(source, /const teamId = bound \?\? input\.member\?\.teamId \?\? null;/);
  assert.doesNotMatch(source, /row\.orgId \?\? row\.team\?\.orgId/);
});

test("gateRequest and session callers admit through budgets and rate limits", async () => {
  const [gate, playground, assistant] = await Promise.all([
    readFile(new URL("../src/lib/gateway/gate.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/internal-api/playground/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/assistant/run.ts", import.meta.url), "utf8"),
  ]);
  assert.match(exportedAsyncFn(gate, "gateRequest"), /await admit\(principal\)/);
  const admit = exportedAsyncFn(gate, "admit");
  assert.match(admit, /await assertBudget\(principal\)/);
  assert.match(admit, /await assertRate\(principal\)/);
  assert.match(playground, /await admit\(principal\)/);
  assert.match(assistant, /await admit\(principal\)/);
});
