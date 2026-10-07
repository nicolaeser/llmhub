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

test("assertBudget checks the whole chain: key, user, member, project, team, and org", async () => {
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
  for (const kind of ["key", "user", "member", "project", "team", "org"]) {
    assert.ok(chain.includes(`kind: "${kind}"`), kind);
  }
  assert.match(chain, /\{ kind: "member", id: principal\.memberId \}/);
  assert.doesNotMatch(fn, /modelMaxBudget/);
});

test("recordUsage charges the user and member budgets alongside key, team, org, and project", async () => {
  const billing = await readFile(
    new URL("../src/lib/gateway/billing.ts", import.meta.url),
    "utf8",
  );
  const fn = exportedAsyncFn(billing, "recordUsage");
  assert.match(fn, /const slice = \{ day, keyId, teamId, orgId, projectId, memberId, userId, model: input\.model \}/);
  for (const model of ["virtualKey", "user", "member", "team", "organization", "project"]) {
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
  const [principal, tenancy] = await Promise.all([
    readFile(new URL("../src/lib/gateway/principal.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/gateway/key-tenancy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(principal, /const \{ tenancy, active \} = await resolveKeyTenancy\(row\);\n\s+if \(!active\) return null;/);
  assert.match(principal, /api key owner is not active/);
  assert.match(principal, /memberId: tenancy\.memberId/);
  assert.match(tenancy, /active: Boolean\(member && !member\.blocked\)/);
  assert.match(tenancy, /active: Boolean\(owner && !owner\.blocked\)/);
  assert.match(tenancy, /tenancy: \{ \.\.\.EMPTY, projectId: row\.projectId, teamId: project\?\.teamId \?\? "", orgId: project\?\.orgId \?\? "" \}/);
  assert.match(tenancy, /tenancy: \{ \.\.\.EMPTY, userId: owner\?\.id \?\? "", orgId: owner\?\.orgId \?\? "" \}/);
  assert.doesNotMatch(tenancy, /row\.orgId \?\?/);
});

test("customer keys are never billed to the console user who created them", async () => {
  const tenancy = await readFile(new URL("../src/lib/gateway/key-tenancy.ts", import.meta.url), "utf8");
  const memberBranch = tenancy.slice(tenancy.indexOf("if (row.memberId)"), tenancy.indexOf("if (row.projectId)"));
  const projectBranch = tenancy.slice(tenancy.indexOf("if (row.projectId)"), tenancy.indexOf("const owner"));
  for (const branch of [memberBranch, projectBranch]) {
    assert.doesNotMatch(branch, /userId:/);
    assert.match(branch, /\.\.\.EMPTY/);
  }
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
