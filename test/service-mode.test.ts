import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicFastSupported,
  applyProviderServiceMode,
  hubServiceMode,
  requestRoutingOverride,
  serviceModeHeaders,
} from "@/lib/gateway/service-mode";

test("hubServiceMode reads OpenAI service_tier and group strategy", () => {
  assert.equal(hubServiceMode({ service_tier: "fast" }), "fast");
  assert.equal(hubServiceMode({ service_tier: "priority" }), "priority");
  assert.equal(hubServiceMode({ service_tier: "flex" }), "flex");
  assert.equal(hubServiceMode({ speed: "fast" }), "fast");
  assert.equal(hubServiceMode({ model: "openai/gpt-4o:nitro" }), "fast");
  assert.equal(hubServiceMode({}, "priority"), "priority");
  assert.equal(hubServiceMode({}, "fast"), "fast");
  assert.equal(hubServiceMode({ service_tier: "auto" }, "least_inflight"), "");
});

test("OpenAI sends priority for fast and keeps flex", () => {
  const openai = applyProviderServiceMode("openai", {}, "fast");
  assert.equal(openai.body.service_tier, "priority");
  const explicit = applyProviderServiceMode("openai", { service_tier: "fast" }, "");
  assert.equal(explicit.body.service_tier, "priority");
  const priority = applyProviderServiceMode(
    "openai",
    { service_tier: "priority" },
    "",
  );
  assert.equal(priority.body.service_tier, "priority");
  const flex = applyProviderServiceMode("openai", { service_tier: "flex" }, "");
  assert.equal(flex.body.service_tier, "flex");
});

test("xAI maps fast to priority and never sends fast", () => {
  const mapped = applyProviderServiceMode("xai", {}, "fast");
  assert.equal(mapped.body.service_tier, "priority");
  const explicit = applyProviderServiceMode(
    "xai",
    { service_tier: "fast" },
    "",
  );
  assert.equal(explicit.body.service_tier, "priority");
});

test("Anthropic uses speed plus beta for fast and auto for priority", () => {
  const fast = applyProviderServiceMode("anthropic", { model: "claude-opus-5-5" }, "fast");
  assert.equal(fast.body.speed, "fast");
  assert.equal(fast.body.service_tier, undefined);
  assert.equal(fast.headers["anthropic-beta"], "fast-mode-2026-02-01");
  const priority = applyProviderServiceMode(
    "anthropic",
    { service_tier: "priority" },
    "",
  );
  assert.equal(priority.body.service_tier, "auto");
  assert.equal(priority.body.speed, undefined);
  const standard = applyProviderServiceMode(
    "anthropic",
    { service_tier: "flex" },
    "",
  );
  assert.equal(standard.body.service_tier, "standard_only");
});

test("OpenRouter pins service_tier and provider.sort", () => {
  const fast = applyProviderServiceMode("openrouter", {}, "fast");
  assert.equal(fast.body.service_tier, "fast");
  assert.equal((fast.body.provider as { sort: string }).sort, "latency");
  const priority = applyProviderServiceMode(
    "openrouter_eu",
    { service_tier: "priority" },
    "",
  );
  assert.equal(priority.body.service_tier, "priority");
  assert.equal((priority.body.provider as { sort: string }).sort, "throughput");
  const flex = applyProviderServiceMode("openrouter", { service_tier: "flex" }, "");
  assert.equal(flex.body.service_tier, "flex");
  assert.equal((flex.body.provider as { sort: string }).sort, "price");
});

test("generic OpenAI-compat maps injected fast to priority", () => {
  const mapped = applyProviderServiceMode("openai_compat", {}, "fast");
  assert.equal(mapped.body.service_tier, "priority");
});

test("requestRoutingOverride still drives local endpoint pick", () => {
  assert.equal(requestRoutingOverride({ service_tier: "fast" }), "fast");
  assert.equal(requestRoutingOverride({ service_tier: "priority" }), "priority");
  assert.equal(requestRoutingOverride({ service_tier: "flex" }), "cost_lowest");
});

test("Anthropic fast mode is only sent to Opus models that support it", () => {
  assert.equal(anthropicFastSupported("claude-opus-4-8"), true);
  assert.equal(anthropicFastSupported("claude-opus-5"), true);
  assert.equal(anthropicFastSupported("claude-opus-5-5"), true);
  assert.equal(anthropicFastSupported("claude-opus-4-7"), false);
  assert.equal(anthropicFastSupported("claude-opus-4-6"), false);
  assert.equal(anthropicFastSupported("claude-sonnet-5-5"), false);
  assert.equal(anthropicFastSupported("claude-fable-5-1"), false);
  const sonnet = applyProviderServiceMode("anthropic", { model: "claude-sonnet-4-6", speed: "fast" }, "");
  assert.equal(sonnet.body.speed, undefined);
  assert.equal(sonnet.headers["anthropic-beta"], undefined);
  assert.deepEqual(serviceModeHeaders("anthropic", { model: "my-alias" }, "fast", "claude-opus-4-8"), {
    "anthropic-beta": "fast-mode-2026-02-01",
  });
  assert.deepEqual(serviceModeHeaders("anthropic", { model: "my-alias" }, "fast", "claude-opus-4-7"), {});
});
