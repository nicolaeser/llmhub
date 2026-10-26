import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextRange, contextWindowOf } from "@/app/(app)/models/_components/deployment-draft";
import { contextIndex, resolveContextWindow, windowKey } from "@/lib/gateway/routing/context-sources";
import { attachModelFacts } from "@/lib/gateway/routing/model-facts";
import { reportedContext } from "@/lib/gateway/upstreams/provider-prices";
import type { ProviderOpt } from "@/types/models";
import type { FactTarget, WindowProvider, WindowRoute } from "@/types/routing";

function provider(id: string, kind: string, windows: Record<string, number>, name = id): WindowProvider {
  return { id, name, kind, discovered: Object.entries(windows).map(([model, contextLength]) => ({ id: model, contextLength })) };
}

const providers: WindowProvider[] = [
  provider("anthropic", "anthropic", { "claude-opus-4-6": 200_000, "claude-sonnet-4-5-20250929": 200_000 }, "Anthropic"),
  provider(
    "router",
    "openrouter",
    {
      "anthropic/claude-opus-4.6": 1_000_000,
      "meta-llama/llama-4-scout:free": 8_192,
      "meta-llama/llama-4-scout": 327_680,
      "x-ai/grok-4-fast": 2_000_000,
      "qwen/qwen3-coder": 262_144,
    },
    "OpenRouter",
  ),
  provider("local", "openai_compat", { "claude-opus-4-6": 64_000, "house-mix": 0 }, "Local vLLM"),
  provider("max", "claude", {}, "Claude Max"),
  provider("vertex", "vertex", {}, "Vertex"),
  provider("xai", "xai", {}, "xAI"),
  provider("compat", "openai_compat", {}, "Compat"),
  provider("router-eu", "openrouter_eu", {}, "OpenRouter EU"),
];

function sources(routes: WindowRoute[] = []) {
  return contextIndex(providers, routes);
}

test("window keys line up dots and dashes, vendor prefixes, and snapshots but keep tags apart", () => {
  assert.equal(windowKey("anthropic/claude-opus-4.6"), windowKey("claude-opus-4-6"));
  assert.equal(windowKey("claude-sonnet-4-5-20250929"), windowKey("claude-sonnet-4-5"));
  assert.equal(windowKey("claude-opus-4-6@20260205"), windowKey("Claude-Opus-4-6"));
  assert.equal(windowKey("gpt-4o-2024-08-06"), windowKey("openai/gpt-4o"));
  assert.notEqual(windowKey("meta-llama/llama-4-scout:free"), windowKey("llama-4-scout"));
  assert.notEqual(windowKey("x-ai/grok-4-fast"), windowKey("grok-4"));
});

test("a provider's own report wins over larger windows elsewhere", () => {
  assert.deepEqual(resolveContextWindow(sources(), "anthropic", "claude-opus-4-6"), { tokens: 200_000, source: "reported" });
  assert.deepEqual(resolveContextWindow(sources(), "local", "claude-opus-4-6"), { tokens: 64_000, source: "reported" });
});

test("a model without its own report borrows the largest window other providers know", () => {
  assert.deepEqual(resolveContextWindow(sources(), "max", "claude-opus-4-6"), {
    tokens: 1_000_000,
    source: "borrowed",
    from: "OpenRouter",
  });
  assert.deepEqual(resolveContextWindow(sources(), "vertex", "claude-opus-4-6@20260205"), {
    tokens: 1_000_000,
    source: "borrowed",
    from: "OpenRouter",
  });
  assert.deepEqual(resolveContextWindow(sources(), "max", "claude-sonnet-4-5"), {
    tokens: 200_000,
    source: "borrowed",
    from: "Anthropic",
  });
});

test("borrowing never crosses tags or incompatible vendors", () => {
  assert.deepEqual(resolveContextWindow(sources(), "router-eu", "meta-llama/llama-4-scout"), {
    tokens: 327_680,
    source: "borrowed",
    from: "OpenRouter",
  });
  assert.deepEqual(resolveContextWindow(sources(), "router-eu", "meta-llama/llama-4-scout:free"), {
    tokens: 8_192,
    source: "borrowed",
    from: "OpenRouter",
  });
  assert.equal(resolveContextWindow(sources(), "xai", "grok-4"), null);
  assert.equal(resolveContextWindow(sources(), "xai", "qwen3-coder"), null);
  assert.deepEqual(resolveContextWindow(sources(), "compat", "qwen3-coder"), {
    tokens: 262_144,
    source: "borrowed",
    from: "OpenRouter",
  });
  assert.equal(resolveContextWindow(sources(), "compat", "unknown-model"), null);
});

test("routes of one model group lend their reported windows to each other", () => {
  const routes: WindowRoute[] = [
    { groupAlias: "house", providerId: "compat", model: "house-mix" },
    { groupAlias: "house", providerId: "anthropic", model: "claude-opus-4-6" },
    { groupAlias: "house", providerId: "local", model: "house-mix" },
    { groupAlias: "other", providerId: "router", model: "x-ai/grok-4-fast" },
  ];
  const index = sources(routes);
  assert.deepEqual(resolveContextWindow(index, "compat", "house-mix"), {
    tokens: 200_000,
    source: "borrowed",
    from: "Anthropic",
  });
  assert.deepEqual(resolveContextWindow(index, "local", "house-mix"), {
    tokens: 200_000,
    source: "borrowed",
    from: "Anthropic",
  });
  assert.deepEqual(resolveContextWindow(index, "anthropic", "claude-opus-4-6"), { tokens: 200_000, source: "reported" });
});

test("discovery reads the context window from every list shape and ignores output caps and junk", () => {
  assert.equal(reportedContext({ id: "claude-opus-5-5", max_input_tokens: 1_000_000, max_tokens: 128_000 }), 1_000_000);
  assert.equal(reportedContext({ id: "claude-haiku", max_tokens: 64_000 }), 0);
  assert.equal(reportedContext({ context_length: 200_000, top_provider: { context_length: 1_000_000 } }), 1_000_000);
  assert.equal(reportedContext({ top_provider: { context_length: "131072" } }), 131_072);
  assert.equal(reportedContext({ max_context_length: 131_072 }), 131_072);
  assert.equal(reportedContext({ max_model_len: 32_768.9 }), 32_768);
  assert.equal(reportedContext({ context_window: 272_000, max_context_window: 400_000 }), 400_000);
  assert.equal(reportedContext({ inputTokenLimit: 1_048_576 }), 1_048_576);
  assert.equal(reportedContext({ input_token_limit: "8192" }), 8_192);
  assert.equal(reportedContext({ context_length: 0, context_window: -1, max_model_len: "n/a", top_provider: null }), 0);
  assert.equal(reportedContext(null), 0);
});

test("routing facts borrow through the cached index, including group peers, with one load per minute", async () => {
  recordedPrisma.reset({
    providerConnection: {
      findMany: () => [
        provider("facts-api", "anthropic", { "claude-opus-4-6": 200_000 }, "Anthropic"),
        provider("facts-max", "claude", {}, "Claude Max"),
        provider("facts-compat", "openai_compat", {}, "Compat"),
      ],
    },
    deployment: {
      findMany: () => [
        { groupAlias: "facts-house", providerId: "facts-compat", model: "house-mix" },
        { groupAlias: "facts-house", providerId: "facts-api", model: "claude-opus-4-6" },
      ],
    },
  });
  const targets: FactTarget[] = [
    { kind: "anthropic", model: "claude-opus-4-6", provider_id: "facts-api" },
    { kind: "claude", model: "claude-opus-4-6", provider_id: "facts-max" },
    { kind: "openai_compat", model: "house-mix", provider_id: "facts-compat" },
    { kind: "claude", model: "nothing-known", provider_id: "facts-max" },
  ];
  await attachModelFacts(targets);
  assert.deepEqual(
    targets.map((target) => target.facts),
    [
      { contextLength: 200_000, contextSource: "reported" },
      { contextLength: 200_000, contextSource: "borrowed" },
      { contextLength: 200_000, contextSource: "borrowed" },
      undefined,
    ],
  );
  await attachModelFacts([{ kind: "claude", model: "claude-opus-4-6", provider_id: "facts-max" }]);
  assert.equal(recordedPrisma.called("providerConnection", "findMany").length, 1);
  assert.equal(recordedPrisma.called("deployment", "findMany").length, 1);
});

test("console helpers keep the source of each window and summarize estimates", () => {
  const options: ProviderOpt[] = [
    {
      id: "p1",
      name: "Claude Max",
      kind: "claude",
      baseUrl: "",
      hasApiKey: false,
      internal: false,
      contextWindows: { "claude-opus-4-6": { tokens: 1_000_000, from: "OpenRouter" }, own: { tokens: 200_000 } },
    },
  ];
  assert.deepEqual(contextWindowOf(options, "p1", " claude-opus-4-6 "), { tokens: 1_000_000, from: "OpenRouter" });
  assert.equal(contextWindowOf(options, "p1", "missing"), null);
  assert.equal(contextWindowOf(options, null, "own"), null);
  assert.deepEqual(contextRange([null, { tokens: 0 }]), { range: "none", min: 0, max: 0, borrowed: "none" });
  assert.deepEqual(contextRange([{ tokens: 200_000 }, null]), { range: "single", min: 200_000, max: 200_000, borrowed: "none" });
  assert.deepEqual(contextRange([{ tokens: 200_000 }, { tokens: 1_000_000, from: "OpenRouter" }]), {
    range: "span",
    min: 200_000,
    max: 1_000_000,
    borrowed: "some",
  });
  assert.deepEqual(contextRange([{ tokens: 400_000, from: "A" }, { tokens: 400_000, from: "B" }]), {
    range: "single",
    min: 400_000,
    max: 400_000,
    borrowed: "all",
  });
});
