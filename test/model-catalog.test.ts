import assert from "node:assert/strict";
import test from "node:test";
import {
  activationEntries,
  splitTag,
  autoRouteEntries,
  catalogStatus,
  displayNameOf,
  jevRequest,
  jevVerdict,
  matchKey,
  nameSimilarity,
  planCatalog,
  snapshotNames,
  vendorOf,
} from "@/lib/gateway/model-catalog";
import type {
  CatalogEntryPlan,
  CatalogGroupInput,
  CatalogProviderInput,
  CatalogRouteInput,
  JevTask,
  StoredCatalogEntry,
} from "@/types/model-catalog";

function provider(id: string, kind: string, ids: string[]): CatalogProviderInput {
  return { id, kind, models: ids.map((model) => ({ id: model, name: model })) };
}

function group(alias: string, extra: Partial<CatalogGroupInput> = {}): CatalogGroupInput {
  return { alias, vendor: "", displayName: "", autoRoutes: null, ...extra };
}

const routing = { autoRoutes: false, minConfidence: 0.9 };

function plan(input: {
  providers: CatalogProviderInput[];
  groups?: CatalogGroupInput[];
  routes?: CatalogRouteInput[];
  stored?: StoredCatalogEntry[];
}) {
  const result = planCatalog({ groups: [], routes: [], stored: [], ...input });
  const byKey = new Map(result.entries.map((entry) => [`${entry.providerId}|${entry.upstreamId}`, entry]));
  return { ...result, get: (providerId: string, upstreamId: string) => byKey.get(`${providerId}|${upstreamId}`) };
}

function stored(entry: CatalogEntryPlan, extra: Partial<StoredCatalogEntry> = {}): StoredCatalogEntry {
  return {
    providerId: entry.providerId,
    upstreamId: entry.upstreamId,
    alias: entry.alias,
    source: entry.source,
    confidence: entry.confidence,
    disabled: entry.disabled,
    classifiedAt: entry.classifiedAt,
    ...extra,
  };
}

test("vendors come from native kinds or aggregator prefixes, never from untrusted names", () => {
  assert.equal(vendorOf("anthropic", "claude-sonnet-4-5"), "anthropic");
  assert.equal(vendorOf("openrouter", "anthropic/claude-sonnet-4.5"), "anthropic");
  assert.equal(vendorOf("openrouter_eu", "x-ai/grok-4"), "xai");
  assert.equal(vendorOf("openrouter", "~anthropic/claude-sonnet-latest"), "anthropic");
  assert.equal(vendorOf("openai_compat", "meta-llama/Llama-3.3-70B-Instruct"), "meta-llama");
  assert.equal(vendorOf("openai_compat", "claude-opus-5-5"), "");
  assert.equal(displayNameOf("openrouter", "anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"), "Claude Sonnet 4.5");
  assert.equal(displayNameOf("anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5"), "");
});

test("date snapshots collapse only when they are the provider's single version", () => {
  const anthropic = snapshotNames(["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]);
  assert.equal(anthropic.get("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  const openai = snapshotNames(["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20"]);
  assert.equal(openai.get("gpt-4o"), "gpt-4o");
  assert.equal(openai.get("gpt-4o-2024-08-06"), "gpt-4o-2024-08-06");
  const twins = snapshotNames(["claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022"]);
  assert.equal(twins.get("claude-3-5-sonnet-20240620"), "claude-3-5-sonnet-20240620");
  assert.equal(matchKey("claude-sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(matchKey("llama-3.3.1-70b"), "llama-3-3-1-70b");
});

test("the same model from several providers shares one alias, variants stay apart", () => {
  const result = plan({
    providers: [
      provider("router", "openrouter", ["anthropic/claude-sonnet-4.5", "openai/gpt-4o", "openai/gpt-4o:free"]),
      provider("anthropic", "anthropic", ["claude-sonnet-4-5-20250929"]),
      provider("openai", "openai", ["gpt-4o", "gpt-4o-2024-08-06"]),
    ],
  });
  assert.equal(result.get("router", "anthropic/claude-sonnet-4.5")?.alias, "claude-sonnet-4-5");
  assert.equal(result.get("anthropic", "claude-sonnet-4-5-20250929")?.alias, "claude-sonnet-4-5");
  assert.equal(result.get("router", "anthropic/claude-sonnet-4.5")?.source, "rule");
  assert.equal(result.get("router", "openai/gpt-4o")?.alias, "gpt-4o");
  assert.equal(result.get("openai", "gpt-4o")?.alias, "gpt-4o");
  assert.equal(result.get("router", "openai/gpt-4o:free")?.alias, "gpt-4o:free");
  assert.equal(result.get("router", "openai/gpt-4o:free")?.source, "");
  assert.equal(result.get("openai", "gpt-4o-2024-08-06")?.alias, "gpt-4o-2024-08-06");
});

test("existing aliases win over new proposals and keep their spelling", () => {
  const result = plan({
    providers: [provider("anthropic", "anthropic", ["claude-sonnet-4-5-20250929"])],
    groups: [group("claude-sonnet-4.5", { vendor: "anthropic" })],
  });
  const entry = result.get("anthropic", "claude-sonnet-4-5-20250929");
  assert.equal(entry?.alias, "claude-sonnet-4.5");
  assert.equal(entry?.source, "rule");
});

test("aliases stay stable when a provider with another spelling joins later", () => {
  const first = plan({ providers: [provider("router", "openrouter", ["anthropic/claude-sonnet-4.5"])] });
  const before = first.get("router", "anthropic/claude-sonnet-4.5")!;
  assert.equal(before.alias, "claude-sonnet-4.5");
  const second = plan({
    providers: [
      provider("router", "openrouter", ["anthropic/claude-sonnet-4.5"]),
      provider("anthropic", "anthropic", ["claude-sonnet-4-5-20250929"]),
    ],
    stored: [stored(before)],
  });
  assert.equal(second.get("anthropic", "claude-sonnet-4-5-20250929")?.alias, "claude-sonnet-4.5");
  assert.equal(second.get("router", "anthropic/claude-sonnet-4.5")?.alias, "claude-sonnet-4.5");
  assert.equal(second.get("router", "anthropic/claude-sonnet-4.5")?.source, "rule");
  assert.equal(second.get("anthropic", "claude-sonnet-4-5-20250929")?.fresh, true);
  const third = plan({
    providers: [
      provider("router", "openrouter", ["anthropic/claude-sonnet-4.5"]),
      provider("anthropic", "anthropic", ["claude-sonnet-4-5-20250929"]),
    ],
    stored: second.entries.map((entry) => stored(entry)),
  });
  assert.deepEqual(
    third.entries.map((entry) => [entry.alias, entry.fresh]),
    [
      ["claude-sonnet-4.5", false],
      ["claude-sonnet-4.5", false],
    ],
  );
});

test("different vendors with the same model name never share an alias", () => {
  const result = plan({ providers: [provider("router", "openrouter", ["mistralai/large", "cohere/large"])] });
  const aliases = result.entries.map((entry) => entry.alias).sort();
  assert.deepEqual(aliases, ["large", "mistralai-large"]);
  const reserved = plan({ providers: [provider("local", "openai_compat", ["auto"])] });
  assert.notEqual(reserved.entries[0]?.alias, "auto");
});

test("routes, manual choices, and former routes keep their alias", () => {
  const providers = [provider("router", "openrouter", ["openai/gpt-4o"]), provider("openai", "openai", ["gpt-4o"])];
  const routed = plan({
    providers,
    groups: [group("chat-default")],
    routes: [{ providerId: "openai", model: "gpt-4o", groupAlias: "chat-default" }],
  });
  assert.equal(routed.get("openai", "gpt-4o")?.alias, "chat-default");
  assert.equal(routed.get("openai", "gpt-4o")?.source, "route");
  assert.equal(routed.get("router", "openai/gpt-4o")?.alias, "gpt-4o");

  const unrouted = plan({
    providers,
    groups: [group("chat-default")],
    stored: [stored(routed.get("openai", "gpt-4o")!)],
  });
  assert.equal(unrouted.get("openai", "gpt-4o")?.alias, "chat-default");
  assert.equal(unrouted.get("openai", "gpt-4o")?.source, "manual");
  assert.equal(unrouted.get("openai", "gpt-4o")?.fresh, false);

  const manual = plan({
    providers,
    stored: [stored(routed.get("router", "openai/gpt-4o")!, { alias: "my-gpt", source: "manual" })],
  });
  assert.equal(manual.get("router", "openai/gpt-4o")?.alias, "my-gpt");
});

test("own servers join a trusted model's alias but are never turned on automatically", () => {
  const result = plan({
    providers: [
      provider("anthropic", "anthropic", ["claude-opus-5-5"]),
      provider("local", "openai_compat", ["claude-opus-5-5"]),
    ],
    groups: [group("claude-opus-5-5", { vendor: "anthropic", autoRoutes: true })],
  });
  const local = result.get("local", "claude-opus-5-5")!;
  assert.equal(local.alias, "claude-opus-5-5");
  assert.equal(local.trusted, false);
  assert.deepEqual(
    autoRouteEntries(result.entries, [group("claude-opus-5-5", { autoRoutes: true })], routing).map(
      (entry) => entry.providerId,
    ),
    ["anthropic"],
  );
  assert.deepEqual(activationEntries(result.entries, 0.9).map((entry) => entry.providerId), ["anthropic"]);
  const alone = plan({ providers: [provider("a", "openai_compat", ["llama3"]), provider("b", "openai_compat", ["llama3"])] });
  assert.equal(activationEntries(alone.entries, 0.9).length, 2);
});

test("disabled providers stay out of activation and automatic routing", () => {
  const first = plan({ providers: [provider("router", "openrouter", ["openai/gpt-4o"])], groups: [group("gpt-4o")] });
  const entry = first.get("router", "openai/gpt-4o")!;
  const next = plan({
    providers: [provider("router", "openrouter", ["openai/gpt-4o"])],
    groups: [group("gpt-4o", { autoRoutes: true })],
    stored: [stored(entry, { disabled: true })],
  });
  assert.equal(next.get("router", "openai/gpt-4o")?.disabled, true);
  assert.deepEqual(activationEntries(next.entries, 0.9), []);
  assert.deepEqual(autoRouteEntries(next.entries, [group("gpt-4o", { autoRoutes: true })], routing), []);
  assert.equal(catalogStatus({ source: "rule", disabled: true }), "disabled");
  assert.equal(catalogStatus({ source: "route", disabled: true }), "active");
  assert.equal(catalogStatus({ source: "", disabled: false }), "new");
});

test("Jev only asks about unmatched models and only offers stronger targets", () => {
  const result = plan({
    providers: [
      provider("router", "openrouter", ["meta-llama/llama-3.3-70b-instruct"]),
      provider("groq", "openai_compat", ["llama-3.3-70b-versatile", "whisper-large-v3"]),
    ],
  });
  assert.deepEqual(
    result.jev.map((task) => [task.providerId, task.upstreamId, task.candidates.map((candidate) => candidate.alias)]),
    [["groq", "llama-3.3-70b-versatile", ["llama-3.3-70b-instruct"]]],
  );
  const classified = result.get("groq", "llama-3.3-70b-versatile")!;
  const again = plan({
    providers: [
      provider("router", "openrouter", ["meta-llama/llama-3.3-70b-instruct"]),
      provider("groq", "openai_compat", ["llama-3.3-70b-versatile"]),
    ],
    stored: [
      stored(classified, {
        alias: "llama-3.3-70b-instruct",
        source: "jev",
        confidence: 0.93,
        classifiedAt: new Date("2026-10-07T00:00:00.000Z"),
      }),
    ],
  });
  assert.equal(again.jev.length, 0);
  assert.equal(again.get("groq", "llama-3.3-70b-versatile")?.alias, "llama-3.3-70b-instruct");
  assert.equal(again.get("groq", "llama-3.3-70b-versatile")?.source, "jev");
  assert.ok(nameSimilarity("llama-3.3-70b-versatile", "llama-3.3-70b-instruct") > 0.5);
  assert.equal(nameSimilarity("gpt-4", "claude-4"), 0);
});

test("Jev requests carry only model metadata and verdicts trust only offered aliases", () => {
  const task: JevTask = {
    providerId: "groq",
    upstreamId: "llama-3.3-70b-versatile",
    kind: "openai_compat",
    vendor: "",
    name: "",
    candidates: [{ alias: "llama-3.3-70b-instruct", label: "llama-3.3-70b-instruct · meta-llama" }],
  };
  const body = jevRequest(task, "jev-latest");
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions.same_model.criteria), ["llama-3.3-70b-instruct", "none"]);
  assert.equal(body.state.provider_model_id, "llama-3.3-70b-versatile");

  const answer = (choice: string, probabilities: Record<string, number>, confidence = 0.8) => ({
    answers: { same_model: { type: "choice", choice, confidence, probabilities } },
  });
  assert.deepEqual(jevVerdict(task, answer("llama-3.3-70b-instruct", { "llama-3.3-70b-instruct": 0.97 })), {
    alias: "llama-3.3-70b-instruct",
    confidence: 0.97,
  });
  assert.deepEqual(jevVerdict(task, answer("llama-3.3-70b-instruct", {}, 0.7)), {
    alias: "llama-3.3-70b-instruct",
    confidence: 0.7,
  });
  assert.equal(jevVerdict(task, answer("none", { none: 0.9 })), null);
  assert.equal(jevVerdict(task, answer("gpt-4o", { "gpt-4o": 1 })), null);
  assert.equal(jevVerdict(task, { error: "nope" }), null);
});

test("aliases inherit the global automatic routing default unless they set their own", () => {
  const result = plan({
    providers: [provider("router", "openrouter", ["openai/gpt-4o", "anthropic/claude-sonnet-4.5", "x-ai/grok-4"])],
    groups: [
      group("gpt-4o"),
      group("claude-sonnet-4-5", { autoRoutes: false }),
      group("grok-4", { autoRoutes: true }),
    ],
  });
  const routed = (autoRoutes: boolean) =>
    autoRouteEntries(result.entries, [group("gpt-4o"), group("claude-sonnet-4-5", { autoRoutes: false }), group("grok-4", { autoRoutes: true })], {
      autoRoutes,
      minConfidence: 0.9,
    })
      .map((entry) => entry.alias)
      .sort();
  assert.deepEqual(routed(true), ["gpt-4o", "grok-4"]);
  assert.deepEqual(routed(false), ["grok-4"]);
});

test("Jev matches route on their own only at the configured confidence", () => {
  const entry = plan({
    providers: [provider("groq", "openai", ["gpt-4o-fast"])],
    groups: [group("gpt-4o")],
  }).get("groq", "gpt-4o-fast")!;
  const matched = { ...entry, alias: "gpt-4o", source: "jev" as const, confidence: 0.85 };
  const groups = [group("gpt-4o", { autoRoutes: true })];
  assert.deepEqual(autoRouteEntries([matched], groups, { autoRoutes: false, minConfidence: 0.9 }), []);
  assert.equal(autoRouteEntries([matched], groups, { autoRoutes: false, minConfidence: 0.8 }).length, 1);
  assert.deepEqual(activationEntries([matched], 0.9), []);
  assert.equal(activationEntries([matched], 0.8).length, 1);
});

test("tags split off as variants of the base model and never merge into it", () => {
  assert.deepEqual(splitTag("gpt-4o:free"), { base: "gpt-4o", tag: "free" });
  assert.deepEqual(splitTag("gpt-4o-batch"), { base: "gpt-4o", tag: "batch" });
  assert.deepEqual(splitTag("llama3:8b"), { base: "llama3:8b", tag: "" });
  assert.deepEqual(splitTag("ft:gpt-4o-mini:org:custom:abc"), { base: "ft:gpt-4o-mini:org:custom:abc", tag: "" });
  assert.deepEqual(splitTag("gpt-4o-mini"), { base: "gpt-4o-mini", tag: "" });

  const result = plan({
    providers: [
      provider("router", "openrouter", ["anthropic/claude-sonnet-4.5:thinking", "openai/gpt-4o:free"]),
      provider("anthropic", "anthropic", ["claude-sonnet-4-5-20250929"]),
      provider("openai", "openai", ["gpt-4o", "gpt-4o-batch"]),
      provider("together", "openai_compat", ["meta-llama/llama-3.3-70b-instruct-free"]),
    ],
    groups: [group("gpt-4o", { vendor: "openai" })],
  });
  assert.equal(result.get("router", "anthropic/claude-sonnet-4.5:thinking")?.alias, "claude-sonnet-4-5:thinking");
  assert.equal(result.get("router", "openai/gpt-4o:free")?.alias, "gpt-4o:free");
  assert.equal(result.get("openai", "gpt-4o-batch")?.alias, "gpt-4o:batch");
  assert.equal(result.get("openai", "gpt-4o")?.alias, "gpt-4o");
  assert.equal(result.get("together", "meta-llama/llama-3.3-70b-instruct-free")?.alias, "llama-3.3-70b-instruct:free");

  const merged = plan({
    providers: [
      provider("router", "openrouter", ["openai/gpt-4o:free"]),
      provider("eu", "openrouter_eu", ["openai/gpt-4o:free"]),
    ],
    groups: [group("gpt-4o", { vendor: "openai", autoRoutes: true }), group("gpt-4o:free", { vendor: "openai" })],
  });
  assert.equal(merged.get("router", "openai/gpt-4o:free")?.alias, "gpt-4o:free");
  assert.equal(merged.get("eu", "openai/gpt-4o:free")?.alias, "gpt-4o:free");
  assert.deepEqual(
    autoRouteEntries(merged.entries, [group("gpt-4o", { autoRoutes: true }), group("gpt-4o:free")], {
      autoRoutes: false,
      minConfidence: 0.9,
    }),
    [],
  );
});

test("Jev only compares variants with the same tag", () => {
  const result = plan({
    providers: [
      provider("router", "openrouter", ["meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-3.3-70b-instruct:free"]),
      provider("groq", "openai_compat", ["llama-3.3-70b-versatile", "llama-3.3-70b-versatile:free"]),
    ],
  });
  const tasks = new Map(result.jev.map((task) => [task.upstreamId, task.candidates.map((candidate) => candidate.alias)]));
  assert.deepEqual(tasks.get("llama-3.3-70b-versatile"), ["llama-3.3-70b-instruct"]);
  assert.deepEqual(tasks.get("llama-3.3-70b-versatile:free"), ["llama-3.3-70b-instruct:free"]);
});

test("model list entries carry variant tags only when there are some", async () => {
  const { modelEntry } = await import("@/lib/gateway/core");
  const created = new Date("2026-10-01T00:00:00.000Z");
  const free = modelEntry("gpt-4o:free", created, null, { vendor: "openai", displayName: "GPT-4o (free)", tags: ["free"] });
  assert.equal(free.owned_by, "openai");
  assert.deepEqual(free.tags, ["free"]);
  const plain = modelEntry("gpt-4o", created, null, { vendor: "openai", displayName: "", tags: [] });
  assert.equal("tags" in plain, false);
  assert.equal(plain.display_name, "gpt-4o");
});
