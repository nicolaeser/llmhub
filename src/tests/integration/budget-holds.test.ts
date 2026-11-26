import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { assertBudget, recordUsage } from "@/lib/gateway/billing/billing";
import { HOLD_TTL_MS, sweepExpiredHolds } from "@/lib/gateway/billing/budget-hold";
import { capRequestCost, costFilter } from "@/lib/gateway/billing/cost-cap";
import { holdRequestBudget } from "@/lib/gateway/billing/hold-request";
import { GateError } from "@/lib/gateway/errors";
import type { HoldPlan } from "@/types/billing";
import type { JsonMap, Principal } from "@/types/gateway";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";
import { closeDatabase } from "./support/database";
import { TestData } from "./support/fixtures";

after(closeDatabase);

const deployment: ResolvedDeployment = {
  id: "it-hold-dep",
  kind: "openai_compat",
  base_url: "https://example.invalid/v1",
  model: "it-hold-model",
  weight: 1,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0.1,
  provider_id: "",
};

const group: ResolvedModelGroup = {
  alias: "it-hold-model",
  strategy: "least_inflight",
  billing_mode: "routed",
  price_input_per_1k: 0,
  price_output_per_1k: 0,
  price_time_zone: "UTC",
  price_windows: [],
  overflow_group: "",
  num_retries: 0,
  fallback_groups: [],
  deployments: [deployment],
  mapped: [deployment],
  session_affinity: false,
};

function callerOf(orgId: string): Principal {
  return {
    actor: orgId,
    userId: "",
    memberId: "",
    teamId: "",
    orgId,
    models: [],
    routeLimits: {},
    trace: {
      endpoint: "/api/v1/chat/completions",
      piiMode: "",
      piiInput: new Set(),
      piiOutput: new Set(),
      guardInput: new Set(),
      guardOutput: new Set(),
      guardBlocked: false,
    },
  };
}

async function admitted(orgId: string, body: JsonMap): Promise<{ principal: Principal; plan: HoldPlan }> {
  const principal = callerOf(orgId);
  capRequestCost(principal, await assertBudget(principal), null);
  const plan = costFilter(principal, body)?.hold;
  assert.ok(plan, "a hard or capped soft budget needs a hold plan");
  return { principal, plan };
}

function chat(maxTokens?: number): JsonMap {
  return { model: "it-hold-model", messages: [{ role: "user", content: "hi" }], ...(maxTokens ? { max_tokens: maxTokens } : {}) };
}

function assertTokens(actual: unknown, expected: number): void {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs((actual as number) - expected) <= 1, `${String(actual)} is not about ${expected}`);
}

async function heldFor(orgId: string): Promise<number> {
  const rows = await prisma.budgetHold.findMany({ where: { entityType: "org", entityId: orgId } });
  return rows.reduce((sum, row) => sum + row.amount.toNumber(), 0);
}

async function removeUsage(orgId: string): Promise<void> {
  await prisma.spendEvent.deleteMany({ where: { orgId } });
  await prisma.usageDaily.deleteMany({ where: { orgId } });
  await prisma.requestLog.deleteMany({ where: { orgId } });
}

test("parallel requests never hold more than a hard budget has left and the last one is shortened", async () => {
  const data = new TestData();
  const org = await data.org({ maxBudget: 1, budgetMode: "hard" });
  try {
    const requests = await Promise.all(Array.from({ length: 6 }, () => admitted(org.id, chat(4000))));
    const results = await Promise.allSettled(requests.map(({ plan }) => holdRequestBudget(plan, deployment, group)));

    const granted = requests.filter((_, index) => results[index]!.status === "fulfilled");
    assert.equal(granted.length, 3);
    const limits = granted.map(({ plan }) => plan.body.max_tokens as number).sort((a, b) => a - b);
    assertTokens(limits[0], 2000);
    assert.deepEqual(limits.slice(1), [4000, 4000]);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof GateError);
        assert.equal(result.reason.status, 429);
        assert.equal(result.reason.code, "budget_exceeded");
      }
    }
    assert.ok(Math.abs((await heldFor(org.id)) - 1) < 1e-9);

    const settled = granted.find(({ plan }) => plan.body.max_tokens === 4000)!;
    const before = settled.principal.trace!.holds!;
    assert.equal(before.length, 1);
    await recordUsage({
      principal: settled.principal,
      model: "it-hold-model",
      deployment,
      usage: { prompt_tokens: 10, completion_tokens: 1000 },
      status: 200,
      outcome: "ok",
      latencyMs: 5,
    });
    assert.deepEqual(settled.principal.trace!.holds, []);
    assert.equal(await prisma.budgetHold.count({ where: { holdId: { in: before } } }), 0);
    const spend = (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).spend.toNumber();
    assert.ok(Math.abs(spend - 0.1) < 1e-9);

    const next = await admitted(org.id, chat(8000));
    await holdRequestBudget(next.plan, deployment, group);
    assertTokens(next.plan.body.max_tokens, 3000);
    assert.ok((await heldFor(org.id)) + spend <= 1 + 1e-9);
  } finally {
    await removeUsage(org.id);
    await data.cleanup();
  }
});

test("a retry on another deployment releases the earlier hold and restores the caller's limit", async () => {
  const data = new TestData();
  const org = await data.org({ maxBudget: 1, budgetMode: "hard" });
  try {
    const { principal, plan } = await admitted(org.id, chat(20_000));
    await holdRequestBudget(plan, deployment, group);
    assertTokens(plan.body.max_tokens, 10_000);
    const first = principal.trace!.holds!;

    const cheap: ResolvedDeployment = { ...deployment, id: "it-hold-cheap", cost_output_per_1k: 0.01 };
    await holdRequestBudget(plan, cheap, { ...group, deployments: [cheap], mapped: [cheap] });
    assert.equal(plan.body.max_tokens, 20_000);
    assert.equal(await prisma.budgetHold.count({ where: { holdId: { in: first } } }), 0);
    assert.ok(Math.abs((await heldFor(org.id)) - 0.2) < 1e-9);
  } finally {
    await data.cleanup();
  }
});

test("a capped soft budget admits below its limit and holds up to the allowed overrun", async () => {
  const data = new TestData();
  const org = await data.org({ maxBudget: 1, budgetMode: "soft", budgetOverrunPct: 50 });
  try {
    await prisma.organization.update({ where: { id: org.id }, data: { spend: 0.9 } });
    const { plan } = await admitted(org.id, chat(10_000));
    assert.ok(Math.abs(plan.ceilings[0]!.limit - 1.5) < 1e-9);
    await holdRequestBudget(plan, deployment, group);
    assertTokens(plan.body.max_tokens, 6000);

    await prisma.organization.update({ where: { id: org.id }, data: { spend: 1 } });
    await assert.rejects(admitted(org.id, chat(10)), (err: unknown) => err instanceof GateError && err.code === "budget_exceeded");
  } finally {
    await data.cleanup();
  }
});

test("expired holds stop counting and the sweep removes them", async () => {
  const data = new TestData();
  const org = await data.org({ maxBudget: 1, budgetMode: "hard" });
  try {
    const past = new Date(Date.now() - HOLD_TTL_MS - 1_000);
    await prisma.budgetHold.create({
      data: { holdId: "it-expired", entityType: "org", entityId: org.id, amount: 1, expiresAt: new Date(past.getTime() + 1) },
    });
    const { plan } = await admitted(org.id, chat(5000));
    await holdRequestBudget(plan, deployment, group);
    assert.equal(plan.body.max_tokens, 5000);

    assert.ok((await sweepExpiredHolds(new Date())) >= 1);
    assert.equal(await prisma.budgetHold.count({ where: { holdId: "it-expired" } }), 0);
  } finally {
    await data.cleanup();
  }
});
