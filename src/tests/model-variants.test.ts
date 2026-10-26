import { gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { splitVariant, variantAlias, variantBody, variantsOf } from "@/lib/gateway/catalog/model-variants";
import {
  applyProviderServiceMode,
  hubServiceMode,
  modeSupport,
  requestRoutingOverride,
  serviceModeHeaders,
  variantRoutes,
} from "@/lib/gateway/dispatch/service-mode";
import { responsesToChat } from "@/lib/gateway/protocols/responses";
import { attachModelFacts, factsByModel } from "@/lib/gateway/routing/model-facts";
import { chatToCodex, codexModelFacts } from "@/lib/gateway/upstreams/codex";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { AuthenticatedSession } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";
import type { FactTarget } from "@/types/routing";

const FAST = `${MODEL}-fast`;

beforeEach(() => {
  resetGateway();
});

afterEach(() => {
  gateway.groups.delete(FAST);
  gateway.groups.set(MODEL, groupRow(MODEL));
});

function variantGroup(alias: string, variants: string[] = []) {
  return groupRow(alias, { variants, strategy: "least_inflight" });
}

function chat(model: string, text: string): JsonMap {
  return { model, messages: [{ role: "user", content: text }] };
}

function chatUpstream(): JsonMap | null | undefined {
  return gateway.upstream.find((call) => call.url === `${UPSTREAM}/chat/completions`)?.body;
}

async function postChat(body: JsonMap, path = "/api/v1/chat/completions"): Promise<Response> {
  const { POST } = path.startsWith("/api/subscription")
    ? await import("@/app/api/subscription/v1/chat/completions/route")
    : await import("@/app/api/v1/chat/completions/route");
  return POST(gatewayRequest(path, body));
}

async function errorCode(res: Response): Promise<string> {
  return String(((await res.json()) as { error: { code: string } }).error.code);
}

function countGroups(): void {
  recordedPrisma.reset({
    modelGroup: {
      count: ({ where }: { where: { alias: { in: string[] } } }) =>
        [...gateway.groups.keys()].filter((alias) => where.alias.in.includes(alias)).length,
    },
  });
}

function operator(): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions: ["models:manage"],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

test("variant aliases split off a known suffix and set the requested mode", () => {
  assert.deepEqual(splitVariant("gpt-6-astra-fast"), { alias: "gpt-6-astra", variant: "fast" });
  assert.deepEqual(splitVariant("gpt-6-astra-ultrafast"), { alias: "gpt-6-astra", variant: "ultrafast" });
  assert.deepEqual(splitVariant("claude-opus-4-8-daybreak"), { alias: "claude-opus-4-8", variant: "daybreak" });
  assert.equal(splitVariant("gpt-6-astra"), null);
  assert.equal(splitVariant("-fast"), null);
  assert.equal(variantAlias("gpt-6", "ultrafast"), "gpt-6-ultrafast");
  assert.deepEqual(variantsOf(["daybreak", "nope", "fast", "fast"]), ["fast", "daybreak"]);
  assert.deepEqual(variantsOf(null), []);
  assert.deepEqual(variantBody({ model: "x-fast", service_tier: "flex" }, "x", "fast"), { model: "x", service_tier: "fast" });
  assert.deepEqual(variantBody({ model: "x-daybreak", access_programs: { cyber: "standard", other: 1 } }, "x", "daybreak"), {
    model: "x",
    access_programs: { cyber: "daybreak", other: 1 },
  });
});

test("Ultra Fast is its own mode, routes like fast, and falls back to the fastest tier a kind has", () => {
  assert.equal(hubServiceMode({ service_tier: "ultrafast" }), "ultrafast");
  assert.equal(requestRoutingOverride({ service_tier: "ultrafast" }), "fast");
  assert.equal(applyProviderServiceMode("openai", { service_tier: "ultrafast" }).body.service_tier, "ultrafast");
  assert.equal(applyProviderServiceMode("xai", { service_tier: "ultrafast" }).body.service_tier, "priority");
  assert.equal(applyProviderServiceMode("openai_compat", { service_tier: "ultrafast" }).body.service_tier, "priority");
  const opus = applyProviderServiceMode("anthropic", { model: "claude-opus-4-8", service_tier: "ultrafast" });
  assert.equal(opus.body.speed, "fast");
  assert.equal(opus.body.service_tier, undefined);
});

test("ChatGPT accounts get the tier their catalog offers plus the Codex routing hint", () => {
  const ultra = applyProviderServiceMode("codex", { service_tier: "ultrafast" }, "", "gpt-6-astra", {
    serviceTiers: ["priority", "ultrafast"],
  });
  assert.equal(ultra.body.service_tier, "ultrafast");
  assert.equal(ultra.headers["x-codex-routing-hint"], "model=gpt-6-astra;tier=ultrafast");
  const plus = applyProviderServiceMode("codex", { service_tier: "ultrafast" }, "", "gpt-5.6-terra", { serviceTiers: ["priority"] });
  assert.equal(plus.body.service_tier, "priority");
  const none = applyProviderServiceMode("codex", { service_tier: "fast", speed: "fast" }, "", "m", { serviceTiers: [] });
  assert.equal(none.body.service_tier, undefined);
  assert.equal(none.body.speed, undefined);
  assert.deepEqual(none.headers, {});
  const fast = { serviceTiers: ["priority"] };
  assert.equal(applyProviderServiceMode("codex", { service_tier: "priority" }, "", "m").body.service_tier, undefined);
  assert.equal(applyProviderServiceMode("codex", { service_tier: "flex" }, "", "m", fast).body.service_tier, undefined);
  assert.equal(applyProviderServiceMode("codex", {}, "fast", "m", fast).body.service_tier, "priority");
  assert.deepEqual(serviceModeHeaders("codex", { service_tier: "priority" }, "", "gpt-5.5", fast), {
    "x-codex-routing-hint": "model=gpt-5.5;tier=priority",
  });
  assert.deepEqual(serviceModeHeaders("codex", { service_tier: "priority" }, "", "gpt-5.5"), {});
});

test("Daybreak reaches only OpenAI and ChatGPT and picks the program the account offers", () => {
  const auto = { access_programs: { cyber: "daybreak" } };
  assert.deepEqual(applyProviderServiceMode("openai", auto).body.access_programs, { cyber: "daybreak_blue" });
  assert.deepEqual(
    applyProviderServiceMode("codex", auto, "", "m", { accessPrograms: ["standard", "daybreak_red"] }).body.access_programs,
    { cyber: "daybreak_red" },
  );
  assert.deepEqual(
    applyProviderServiceMode("codex", auto, "", "m", { accessPrograms: ["daybreak_red", "daybreak_blue"] }).body.access_programs,
    { cyber: "daybreak_blue" },
  );
  assert.deepEqual(applyProviderServiceMode("codex", { access_programs: { cyber: "standard" } }, "", "m").body.access_programs, {
    cyber: "standard",
  });
  assert.equal("access_programs" in applyProviderServiceMode("codex", auto, "", "m").body, false);
  assert.equal("access_programs" in applyProviderServiceMode("codex", auto, "", "m", { accessPrograms: ["standard"] }).body, false);
  for (const kind of ["anthropic", "claude", "xai", "openrouter", "openai_compat", "grok_build"]) {
    assert.equal("access_programs" in applyProviderServiceMode(kind, auto).body, false, kind);
  }
});

test("mode support tells confirmed, unverified, and missing routes apart", () => {
  assert.equal(modeSupport({ kind: "openai", model: "gpt-6-astra" }, "fast"), "confirmed");
  assert.equal(modeSupport({ kind: "openai", model: "gpt-6-astra" }, "ultrafast"), "unverified");
  assert.equal(modeSupport({ kind: "openai", model: "gpt-6-astra" }, "daybreak"), "unverified");
  assert.equal(modeSupport({ kind: "codex", model: "m" }, "ultrafast"), "none");
  assert.equal(modeSupport({ kind: "codex", model: "m" }, "fast"), "none");
  assert.equal(modeSupport({ kind: "codex", model: "m", facts: { serviceTiers: ["priority"] } }, "ultrafast"), "none");
  assert.equal(modeSupport({ kind: "codex", model: "m", facts: { serviceTiers: ["priority"] } }, "fast"), "confirmed");
  assert.equal(modeSupport({ kind: "codex", model: "m", facts: { accessPrograms: ["standard"] } }, "daybreak"), "none");
  assert.equal(
    modeSupport({ kind: "codex", model: "m", facts: { accessPrograms: ["daybreak_blue"] } }, "daybreak", "daybreak_red"),
    "none",
  );
  assert.equal(modeSupport({ kind: "claude", model: "claude-opus-4-8" }, "fast"), "confirmed");
  assert.equal(modeSupport({ kind: "claude", model: "claude-sonnet-4-6" }, "fast"), "none");
  assert.equal(modeSupport({ kind: "claude", model: "claude-opus-4-8" }, "ultrafast"), "none");
  assert.equal(modeSupport({ kind: "openai_compat", model: "m" }, "fast"), "unverified");
  assert.equal(modeSupport({ kind: "grok_build", model: "m" }, "fast"), "none");
});

test("routing keeps Ultra Fast and Daybreak on routes that serve them and prefers fast routes", () => {
  const plus = { kind: "codex", model: "m", facts: { serviceTiers: ["priority"], accessPrograms: ["standard"] } };
  const pro = { kind: "codex", model: "m", facts: { serviceTiers: ["priority", "ultrafast"], accessPrograms: ["daybreak_blue"] } };
  const sonnet = { kind: "claude", model: "claude-sonnet-4-6" };
  const ultra = variantRoutes([plus, pro], { service_tier: "ultrafast" });
  assert.equal(ultra.error, null);
  assert.deepEqual([plus, pro].filter(ultra.serves), [pro]);
  const daybreak = variantRoutes([plus, pro], { access_programs: { cyber: "daybreak" } });
  assert.deepEqual([plus, pro].filter(daybreak.serves), [pro]);
  const missing = variantRoutes([plus, sonnet], { service_tier: "ultrafast" });
  assert.equal(missing.error?.code, "unsupported_parameter");
  assert.equal(missing.error?.param, "service_tier");
  assert.equal(variantRoutes([sonnet], { access_programs: { cyber: "daybreak" } }).error?.param, "access_programs");
  const fast = variantRoutes([sonnet, plus], { service_tier: "fast" });
  assert.deepEqual([sonnet, plus].filter(fast.serves), [plus]);
  const lenient = variantRoutes([sonnet], { service_tier: "fast" });
  assert.equal(lenient.error, null);
  assert.deepEqual([sonnet].filter(lenient.serves), [sonnet]);
  const plain = variantRoutes([sonnet, plus], {});
  assert.deepEqual([sonnet, plus].filter(plain.serves), [sonnet, plus]);
});

test("ChatGPT catalogs report service tiers and access programs per model", () => {
  assert.deepEqual(
    codexModelFacts({
      slug: "a",
      service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast" }],
      available_access_programs: { cyber: ["standard", "daybreak_blue", 3] },
    }),
    { serviceTiers: ["priority", "ultrafast"], accessPrograms: ["standard", "daybreak_blue"] },
  );
  assert.deepEqual(codexModelFacts({ slug: "b", additional_speed_tiers: ["fast"] }), { serviceTiers: ["priority"] });
  assert.deepEqual(codexModelFacts({ slug: "c", service_tiers: [], additional_speed_tiers: [] }), { serviceTiers: [] });
  assert.deepEqual(codexModelFacts({ slug: "d" }), {});
  const [kept] = discoveredOf([{ id: "a", name: "a", serviceTiers: ["priority"], accessPrograms: [] }]);
  assert.deepEqual(kept?.serviceTiers, ["priority"]);
  assert.deepEqual(kept?.accessPrograms, []);
  assert.equal("serviceTiers" in discoveredOf([{ id: "b" }])[0]!, false);
  assert.deepEqual(factsByModel([{ id: "a", serviceTiers: ["priority"] }, { id: "b" }]), new Map([["a", { serviceTiers: ["priority"] }]]));
});

test("tiers and programs survive the Responses and ChatGPT conversions", () => {
  const { body } = responsesToChat(
    { model: "m", input: "hi", service_tier: "ultrafast", access_programs: { cyber: "daybreak_red" } },
    [],
  );
  assert.equal(body.service_tier, "ultrafast");
  assert.deepEqual(body.access_programs, { cyber: "daybreak_red" });
  const codex = chatToCodex({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    service_tier: "priority",
    access_programs: { cyber: "daybreak_blue", extra: true },
  });
  assert.equal(codex.service_tier, "priority");
  assert.deepEqual(codex.access_programs, { cyber: "daybreak_blue" });
  assert.equal("service_tier" in chatToCodex({ model: "m", messages: [] }), false);
});

test("routing reads model facts once per provider for every route", async () => {
  recordedPrisma.reset({
    providerConnection: {
      findMany: () => [
        { id: "facts-provider", discovered: [{ id: "gpt-6-astra", serviceTiers: ["priority", "ultrafast"] }] },
        { id: "api-provider", discovered: [{ id: "gpt-6-astra", contextLength: 400_000 }] },
      ],
    },
  });
  const targets: FactTarget[] = [
    { kind: "codex", model: "gpt-6-astra", provider_id: "facts-provider" },
    { kind: "codex", model: "gpt-unknown", provider_id: "facts-provider" },
    { kind: "openai", model: "gpt-6-astra", provider_id: "api-provider" },
    { kind: "openai_compat", model: "local", provider_id: "" },
  ];
  await attachModelFacts(targets);
  assert.deepEqual(targets[0]!.facts, {
    serviceTiers: ["priority", "ultrafast"],
    contextLength: 400_000,
    contextSource: "borrowed",
  });
  assert.equal(targets[1]!.facts, undefined);
  assert.deepEqual(targets[2]!.facts, { contextLength: 400_000, contextSource: "reported" });
  assert.equal(targets[3]!.facts, undefined);
  await attachModelFacts([
    { kind: "codex", model: "gpt-6-astra", provider_id: "facts-provider" },
    { kind: "openai", model: "gpt-6-astra", provider_id: "api-provider" },
  ]);
  assert.equal(recordedPrisma.called("providerConnection", "findMany").length, 1);
});

test("a variant alias routes to its model with the mode applied", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  const res = await postChat(chat(FAST, "variant fast"));
  assert.equal(res.status, 200);
  assert.equal(chatUpstream()?.model, MODEL);
  assert.equal(chatUpstream()?.service_tier, "priority");
});

test("variants that are not enabled stay unknown models", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  const res = await postChat(chat(`${MODEL}-ultrafast`, "variant off"));
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "model_not_found");
  assert.equal(gateway.upstream.length, 0);
});

test("Daybreak on a model without an OpenAI or ChatGPT route fails before any upstream call", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["daybreak"]));
  const res = await postChat(chat(`${MODEL}-daybreak`, "variant daybreak"));
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "unsupported_parameter");
  assert.equal(gateway.upstream.length, 0);
});

test("a real model named like a variant wins over the variant", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  gateway.groups.set(FAST, variantGroup(FAST));
  const res = await postChat(chat(FAST, "real alias"));
  assert.equal(res.status, 200);
  assert.equal(chatUpstream()?.model, FAST);
  assert.equal(chatUpstream()?.service_tier, undefined);
  const { GET } = await import("@/app/api/v1/models/route");
  const list = (await (await GET(new Request("http://hub.local/api/v1/models", { headers: { authorization: "Bearer sk-hub-test" } }))).json()) as {
    data: JsonMap[];
  };
  assert.equal(list.data.filter((model) => model.id === FAST).length, 1);
});

test("Responses requests to a variant keep the mode", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  const { POST } = await import("@/app/api/v1/responses/route");
  const res = await POST(gatewayRequest("/api/v1/responses", { model: FAST, input: "variant responses" }));
  assert.equal(res.status, 200);
  assert.equal(chatUpstream()?.model, MODEL);
  assert.equal(chatUpstream()?.service_tier, "priority");
});

test("subscription callers reach API variants through the api/ prefix", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  const res = await postChat(chat(`api/${FAST}`, "variant via api"), "/api/subscription/v1/chat/completions");
  assert.equal(res.status, 200);
  assert.equal(chatUpstream()?.model, MODEL);
  assert.equal(chatUpstream()?.service_tier, "priority");
});

test("the models list shows variants a route can serve and retrieves them by id", async () => {
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast", "ultrafast"]));
  const headers = { authorization: "Bearer sk-hub-test" };
  const { GET } = await import("@/app/api/v1/models/route");
  const list = (await (await GET(new Request("http://hub.local/api/v1/models", { headers }))).json()) as { data: JsonMap[] };
  const fast = list.data.find((model) => model.id === FAST);
  assert.equal(fast?.variant, "fast");
  assert.equal(fast?.display_name, `${MODEL} (Fast)`);
  assert.equal(list.data.some((model) => model.id === `${MODEL}-ultrafast`), false);
  const subscription = await import("@/app/api/subscription/v1/models/route");
  const viaApi = (await (await subscription.GET(new Request("http://hub.local/api/subscription/v1/models", { headers }))).json()) as {
    data: JsonMap[];
  };
  assert.equal(viaApi.data.find((model) => model.id === `api/${FAST}`)?.route, "api");
  const one = await import("@/app/api/v1/models/[id]/route");
  const found = await one.GET(new Request(`http://hub.local/api/v1/models/${FAST}`, { headers }), {
    params: Promise.resolve({ id: FAST }),
  });
  assert.equal(found.status, 200);
  assert.equal(((await found.json()) as JsonMap).variant, "fast");
  const missing = await one.GET(new Request(`http://hub.local/api/v1/models/${MODEL}-ultrafast`, { headers }), {
    params: Promise.resolve({ id: `${MODEL}-ultrafast` }),
  });
  assert.equal(missing.status, 404);
  const codex = (await (await GET(new Request("http://hub.local/api/v1/models?client_version=0.162.1", { headers }))).json()) as {
    models: JsonMap[];
  };
  assert.ok(codex.models.some((model) => model.slug === FAST));
});

test("model groups reject variants whose alias another model already uses", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { createModelGroup } = await import("@/lib/models/groups");
  countGroups();
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  gateway.groups.set("other-ultrafast", variantGroup("other-ultrafast"));
  const base = { strategy: "least_inflight", numRetries: 0, overflowGroup: "", fallbackGroups: [] };
  await runAsPrincipal(operator(), async () => {
    await assert.rejects(createModelGroup({ ...base, alias: FAST }), /ALIAS_EXISTS/);
    await assert.rejects(createModelGroup({ ...base, alias: "other", variants: ["ultrafast"] }), /VARIANT_TAKEN/);
  });
  gateway.groups.delete("other-ultrafast");
});

test("updating a model keeps its variants unless they are sent", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { updateModelGroup } = await import("@/lib/models/groups");
  countGroups();
  gateway.groups.set(MODEL, variantGroup(MODEL, ["fast"]));
  gateway.groups.set(`${MODEL}-daybreak`, variantGroup(`${MODEL}-daybreak`));
  const base = { alias: MODEL, strategy: "least_inflight", numRetries: 0, overflowGroup: "", fallbackGroups: [] };
  await runAsPrincipal(operator(), async () => {
    await assert.rejects(updateModelGroup({ ...base, variants: ["fast", "daybreak"] }), /VARIANT_TAKEN/);
    await updateModelGroup(base);
  });
  const update = recordedPrisma.called("modelGroup", "update").at(-1)?.args as { data: { variants: string[] } } | undefined;
  assert.deepEqual(update?.data.variants, ["fast"]);
  gateway.groups.delete(`${MODEL}-daybreak`);
});
