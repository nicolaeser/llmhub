import assert from "node:assert/strict";
import test from "node:test";
import type { Deployment } from "@/types/gateway";

function deployment(
  over: Partial<Deployment> & Pick<Deployment, "id">,
): Deployment {
  return {
    kind: "openai",
    base_url: "https://example.invalid/v1",
    model: "m",
    weight: 1,
    cost_input_per_1k: 1,
    cost_output_per_1k: 1,
    provider_id: "",
    ...over,
  };
}

test(
  "weighted pick returns a deployment",
  async () => {
    const { pickWeighted } = await import("@/lib/gateway/router");
    const picked = pickWeighted([{ id: "d1", weight: 1 }]);
    assert.ok(picked);
  },
);

test(
  "pickCostLowest selects the cheapest deployment",
  async () => {
    const { pickCostLowest } = await import("@/lib/gateway/router");
    const cheap = deployment({
      id: "cheap",
      cost_input_per_1k: 0.1,
      cost_output_per_1k: 0.2,
    });
    const pricey = deployment({
      id: "pricey",
      cost_input_per_1k: 2,
      cost_output_per_1k: 3,
    });
    assert.equal(pickCostLowest([pricey, cheap]).id, "cheap");
  },
);

test(
  "pickPriority selects the highest weight",
  async () => {
    const { pickPriority } = await import("@/lib/gateway/router");
    const low = deployment({ id: "low", weight: 1 });
    const high = deployment({ id: "high", weight: 10 });
    assert.equal(pickPriority([low, high]).id, "high");
  },
);

test(
  "pickLatencyEwma prefers unexplored then the lowest EWMA",
  async () => {
    const { pickLatencyEwma, nextLatencyEwma } = await import(
      "@/lib/gateway/router"
    );
    const slow = deployment({ id: "slow", weight: 1 });
    const fast = deployment({ id: "fast", weight: 1 });
    const fresh = deployment({ id: "fresh", weight: 1 });
    const ewma = new Map<string, number>([
      ["slow", 800],
      ["fast", 120],
    ]);
    assert.equal(pickLatencyEwma([slow, fast], ewma).id, "fast");
    assert.equal(pickLatencyEwma([slow, fast, fresh], ewma).id, "fresh");
    assert.equal(nextLatencyEwma(undefined, 100), 100);
    assert.equal(nextLatencyEwma(100, 200), 0.3 * 200 + 0.7 * 100);
  },
);

test(
  "service_tier maps to fast and priority routing",
  async () => {
    const { requestRoutingOverride } = await import("@/lib/gateway/service-mode");
    assert.equal(requestRoutingOverride({ service_tier: "priority" }), "priority");
    assert.equal(requestRoutingOverride({ service_tier: "fast" }), "fast");
    assert.equal(requestRoutingOverride({ service_tier: "flex" }), "cost_lowest");
    assert.equal(requestRoutingOverride({ service_tier: "auto" }), "");
    assert.equal(requestRoutingOverride({}), "");
  },
);

test(
  "pickLeastInflight selects the lowest inflight count",
  async () => {
    const { pickLeastInflight } = await import("@/lib/gateway/router");
    const busy = deployment({ id: "busy" });
    const idle = deployment({ id: "idle" });
    const inflight = new Map<string, number>([
      ["busy", 4],
      ["idle", 1],
    ]);
    assert.equal(pickLeastInflight([busy, idle], inflight).id, "idle");
  },
);
