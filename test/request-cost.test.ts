import assert from "node:assert/strict";
import test from "node:test";
import {
  capRequestCost,
  costFilter,
  costRejected,
  costRejection,
  estimateCost,
  maxCostHeader,
  requestTokens,
} from "@/lib/gateway/cost-cap";
import { GateError } from "@/lib/gateway/errors";
import type { Group, Principal, ResolvedDeployment, VirtualKeyView } from "@/types/gateway";

function deployment(id: string, input: number, output: number, kind = "openai"): ResolvedDeployment {
  return {
    id,
    kind,
    base_url: "https://example.invalid/v1",
    model: id,
    weight: 1,
    cost_input_per_1k: input,
    cost_output_per_1k: output,
    provider_id: "",
  };
}

function group(deployments: ResolvedDeployment[], over: Partial<Group> = {}): Group {
  return {
    alias: "gpt",
    strategy: "least_inflight",
    billing_mode: "routed",
    price_input_per_1k: 0,
    price_output_per_1k: 0,
    price_time_zone: "UTC",
    price_windows: [],
    overflow_group: "",
    num_retries: 0,
    fallback_groups: [],
    deployments,
    mapped: deployments,
    ...over,
  };
}

function traced(key?: Partial<VirtualKeyView>): Principal {
  return {
    actor: "k",
    ...(key ? { key: { max_request_cost: 0, ...key } as VirtualKeyView } : {}),
    teamId: "",
    orgId: "",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    trace: { endpoint: "/v1/chat/completions", piiMode: "", piiInput: new Set(), piiOutput: new Set() },
  };
}

test("requestTokens counts prompt text and caps output by max_tokens times choices", () => {
  const tokens = requestTokens({
    model: "a-very-long-model-name-that-is-not-prompt",
    messages: [{ role: "user", content: "x".repeat(396) }],
    max_tokens: 500,
    n: 3,
  });
  assert.equal(tokens.prompt, 100);
  assert.equal(tokens.completion, 1500);
  const image = (url: string) =>
    requestTokens({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }).prompt;
  assert.equal(image(`data:image/png;base64,${"A".repeat(100_000)}`), image("data:image/png;base64,AAAA"));
  assert.equal(requestTokens({ input: "hi", max_output_tokens: 64 }).completion, 64);
  assert.equal(requestTokens({ messages: [] }).completion, 0);
});

test("estimateCost prices input and max output at the deployment rates", () => {
  const dep = deployment("d1", 1, 2);
  const tokens = { prompt: 1000, completion: 500 };
  assert.equal(estimateCost(dep, group([dep]), {}, tokens, new Date()), 2);
  assert.equal(estimateCost(dep, group([dep]), { service_tier: "priority" }, tokens, new Date()), 4);
  const custom = group([dep], { billing_mode: "custom", price_input_per_1k: 3, price_output_per_1k: 4 });
  assert.equal(estimateCost(dep, custom, {}, tokens, new Date()), 5);
});

test("x-hub-max-cost accepts only positive numbers", () => {
  assert.equal(maxCostHeader(new Headers()), null);
  assert.equal(maxCostHeader(new Headers({ "x-hub-max-cost": " 0.25 " })), 0.25);
  for (const value of ["0", "-1", "abc", ""]) {
    assert.throws(
      () => maxCostHeader(new Headers({ "x-hub-max-cost": value })),
      (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "invalid_request",
    );
  }
});

test("the tightest of header, key limit, and remaining budget wins", () => {
  const principal = traced({ max_request_cost: 2 });
  capRequestCost(principal, { limit: 5, budget: "org" }, 10);
  assert.deepEqual(principal.trace?.costCap, { limit: 2, budget: null });

  capRequestCost(principal, { limit: 5, budget: "org" }, 1);
  assert.deepEqual(principal.trace?.costCap, { limit: 1, budget: null });

  capRequestCost(principal, { limit: 0.5, budget: "team" }, 1);
  assert.deepEqual(principal.trace?.costCap, { limit: 0.5, budget: "team" });

  const unlimited = traced();
  capRequestCost(unlimited, null, null);
  assert.equal(unlimited.trace?.costCap, null);
  assert.equal(costFilter(unlimited, { max_tokens: 10 }), undefined);
});

test("cost rejections use cost_limit_exceeded or budget_exceeded", () => {
  const limit = costRejection({ limit: 1, budget: null }, 2);
  assert.equal(limit.status, 400);
  assert.equal(limit.code, "cost_limit_exceeded");
  const budget = costRejection({ limit: 1, budget: "project" }, 2);
  assert.equal(budget.status, 429);
  assert.equal(budget.code, "budget_exceeded");
  assert.match(budget.message, /remaining project budget/);
  assert.ok(costRejected(limit) && costRejected(budget));
  assert.equal(costRejected(new GateError(429, "rate_limit_exceeded", "rpm exceeded")), false);
});

const groups = new Map([
  [
    "mixed",
    {
      alias: "mixed",
      enabled: true,
      strategy: "priority",
      billingMode: "routed",
      priceInput: 0,
      priceOutput: 0,
      priceTimeZone: "UTC",
      priceWindows: [],
      overflowGroup: "",
      numRetries: 0,
      fallbackGroups: ["cheap"],
      deployments: [
        { id: "pricey", kind: "openai_compat", baseUrl: "https://a.example.test/v1", model: "pricey", weight: 10, costInput: 10, costOutput: 10, providerId: null, provider: null },
        { id: "budget", kind: "openai_compat", baseUrl: "https://b.example.test/v1", model: "budget", weight: 1, costInput: 1, costOutput: 1, providerId: null, provider: null },
      ],
    },
  ],
  [
    "cheap",
    {
      alias: "cheap",
      enabled: true,
      strategy: "priority",
      billingMode: "routed",
      priceInput: 0,
      priceOutput: 0,
      priceTimeZone: "UTC",
      priceWindows: [],
      overflowGroup: "",
      numRetries: 0,
      fallbackGroups: [],
      deployments: [
        { id: "tiny", kind: "openai_compat", baseUrl: "https://c.example.test/v1", model: "tiny", weight: 1, costInput: 0.001, costOutput: 0.001, providerId: null, provider: null },
      ],
    },
  ],
]);

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: {
    findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null,
  },
};

const body = { messages: [{ role: "user", content: "x".repeat(4000) }], max_tokens: 1000 };

test("routing skips deployments whose estimate exceeds the cap", async () => {
  const { acquireGroup, loadGroup } = await import("@/lib/gateway/runtime");
  const mixed = await loadGroup("mixed");
  const principal = traced({ max_request_cost: 5 });
  capRequestCost(principal, null, null);
  const acquired = await acquireGroup(mixed, undefined, undefined, "", costFilter(principal, body));
  assert.equal(acquired.dep.id, "budget");
  acquired.release();

  capRequestCost(principal, null, 1);
  await assert.rejects(
    acquireGroup(mixed, undefined, undefined, "", costFilter(principal, body)),
    (err: unknown) => err instanceof GateError && err.code === "cost_limit_exceeded",
  );
});

test("a cost rejection stops routing instead of falling back", async () => {
  const { withDeployment } = await import("@/lib/gateway/chat");
  const principal = traced();
  capRequestCost(principal, { limit: 1, budget: "key" }, null);
  const used: string[] = [];
  await assert.rejects(
    withDeployment(["mixed"], {}, async (dep) => used.push(dep.id), { cost: costFilter(principal, body) }),
    (err: unknown) => err instanceof GateError && err.code === "budget_exceeded" && err.status === 429,
  );
  assert.deepEqual(used, []);
});
