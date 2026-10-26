import { chatReply, gateway, gatewayRequest, groupRow, MODEL, resetGateway, UPSTREAM } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { contextDemand } from "@/lib/gateway/billing/tokens";
import { upstreamError } from "@/lib/gateway/dispatch/upstream";
import { GateError } from "@/lib/gateway/errors";
import { ContextFit, contextOverflow } from "@/lib/gateway/routing/context-window";
import { factsByModel } from "@/lib/gateway/routing/model-facts";
import { coolingDown } from "@/lib/gateway/routing/provider-health";
import type { JsonMap } from "@/types/gateway";
import type { ContextDemand } from "@/types/routing";

type Route = { model: string; window: number; borrowed?: boolean };

const catalog = new Map<string, { id: string; contextLength: number }[]>();
const memberships: { groupAlias: string; providerId: string; model: string }[] = [];
const aliases: string[] = [];
let serial = 0;

beforeEach(() => {
  resetGateway();
  recordedPrisma.reset({
    providerConnection: {
      findMany: () => [...catalog].map(([id, discovered]) => ({ id, name: id, kind: "openai_compat", discovered })),
    },
    deployment: { findMany: () => memberships },
  });
});

afterEach(() => {
  for (const alias of aliases.splice(0)) gateway.groups.delete(alias);
  gateway.groups.set(MODEL, groupRow(MODEL));
});

function sizedGroup(routes: Route[], change: Record<string, unknown> = {}): string {
  serial += 1;
  const alias = `ctx-${serial}`;
  const provider = `ctx-provider-${serial}`;
  catalog.set(provider, routes.filter((route) => !route.borrowed).map((route) => ({ id: route.model, contextLength: route.window })));
  const lent = routes.filter((route) => route.borrowed);
  if (lent.length) catalog.set(`${provider}-donor`, lent.map((route) => ({ id: route.model, contextLength: route.window })));
  memberships.push(...routes.map((route) => ({ groupAlias: alias, providerId: provider, model: route.model })));
  gateway.groups.set(
    alias,
    groupRow(alias, {
      deployments: routes.map((route, index) => ({
        id: `${alias}-${route.model}`,
        kind: "openai_compat",
        baseUrl: UPSTREAM,
        model: route.model,
        weight: routes.length - index,
        costInput: 0,
        costOutput: 0,
        providerId: provider,
        provider: null,
      })),
      ...change,
    }),
  );
  aliases.push(alias);
  return alias;
}

function words(tokens: number): string {
  return "word ".repeat(Math.ceil((tokens * 4) / 5));
}

function chat(model: string, tokens: number, change: JsonMap = {}): JsonMap {
  return { model, messages: [{ role: "user", content: words(tokens) }], ...change };
}

function upstreamModels(): string[] {
  return gateway.upstream.map((call) => String(call.body?.model ?? ""));
}

async function post(path: string, body: JsonMap): Promise<Response> {
  const routes: Record<string, () => Promise<{ POST(req: Request): Promise<Response> }>> = {
    "/api/v1/chat/completions": () => import("@/app/api/v1/chat/completions/route"),
    "/api/v1/messages": () => import("@/app/api/v1/messages/route"),
    "/api/v1/responses": () => import("@/app/api/v1/responses/route"),
  };
  const { POST } = await routes[path]!();
  return POST(gatewayRequest(path, body));
}

function overflowReply(message: string, code: string | null = null): Response {
  return Response.json({ error: { message, type: "invalid_request_error", param: "messages", code } }, { status: 400 });
}

function demand(input: number, output = 0): () => ContextDemand {
  return () => ({ input, output });
}

test("contextDemand counts prompt text, tool results, and tools but not binary data, signatures, or thinking", () => {
  const text = "a".repeat(400);
  assert.deepEqual(contextDemand({ model: "m", messages: [{ role: "user", content: text }] }), { input: 101, output: 0 });
  const anthropic = contextDemand({
    model: "m",
    system: [{ type: "text", text }],
    tools: [{ name: "read", description: text, input_schema: { type: "object" } }],
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: text, signature: "s".repeat(800) }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4_000) } },
        ],
      },
    ],
  });
  assert.ok(anthropic.input >= 300 && anthropic.input < 330, `input ${anthropic.input}`);
  const image = contextDemand({
    model: "m",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(9_000)}` } }] }],
  });
  assert.ok(image.input < 10, `input ${image.input}`);
});

test("contextDemand adds the requested output tokens once, whatever the protocol calls them", () => {
  assert.equal(contextDemand({ messages: [], max_tokens: 2_000, n: 3 }).output, 2_000);
  assert.equal(contextDemand({ messages: [], max_completion_tokens: 900 }).output, 900);
  assert.equal(contextDemand({ input: "hi", max_output_tokens: 64 }).output, 64);
  assert.equal(contextDemand({ messages: [] }).output, 0);
});

test("a context plan never filters unknown windows and separates tight from short groups", () => {
  const unknown = { id: "unknown" };
  const small = { id: "small", facts: { contextLength: 1_000 } };
  const large = { id: "large", facts: { contextLength: 100_000 } };
  const measured: string[] = [];
  const lazy = new ContextFit(() => {
    measured.push("measured");
    return { input: 50_000, output: 0 };
  });
  assert.equal(lazy.plan([unknown, { id: "zero", facts: { contextLength: 0 } }], false), "open");
  assert.deepEqual(measured, []);
  const mixed = new ContextFit(demand(5_000));
  assert.equal(mixed.plan([unknown, small], false), "narrowed");
  assert.equal(mixed.fits(unknown, false), true);
  assert.equal(mixed.short, false);
  assert.equal(new ContextFit(demand(5_000)).plan([small, large], false), "narrowed");
  assert.equal(new ContextFit(demand(800, 400)).plan([small], false), "tight");
  assert.equal(new ContextFit(demand(800, 400)).plan([small], true), "open");
  const short = new ContextFit(demand(5_000, 100));
  assert.equal(short.plan([small], false), "short");
  assert.equal(short.short, true);
  const rejection = short.rejection("gpt-small");
  assert.equal(rejection.status, 400);
  assert.equal(rejection.code, "context_length_exceeded");
  assert.equal(rejection.requestScoped, true);
  assert.match(rejection.message, /^prompt is too long: 5000 tokens > 1000 maximum/);
  assert.match(rejection.message, /100 requested output tokens/);
  assert.match(rejection.message, /gpt-small/);
  const overflowed = new ContextFit(demand(500));
  assert.equal(overflowed.fits(small, false), true);
  overflowed.overflowed(small);
  assert.equal(overflowed.fits(small, false), false);
  assert.equal(overflowed.fits(large, false), true);
  assert.equal(overflowed.fits(unknown, false), true);
});

test("borrowed windows only defer: they never filter, shape the plan, raise the overflow floor, or measure early", () => {
  const borrowed = { id: "borrowed", facts: { contextLength: 1_000, contextSource: "borrowed" as const } };
  const roomy = { id: "roomy", facts: { contextLength: 100_000, contextSource: "borrowed" as const } };
  const reported = { id: "reported", facts: { contextLength: 100_000, contextSource: "reported" as const } };
  const measured: string[] = [];
  const lazy = new ContextFit(() => {
    measured.push("measured");
    return { input: 50_000, output: 0 };
  });
  assert.deepEqual(lazy.doubted([{ id: "unknown" }, reported], false), []);
  assert.deepEqual(measured, []);
  const fit = new ContextFit(demand(5_000));
  assert.equal(fit.plan([borrowed], false), "open");
  assert.equal(fit.plan([borrowed, reported], false), "open");
  assert.deepEqual(fit.doubted([borrowed, roomy, reported], false), [borrowed]);
  assert.equal(fit.serves(borrowed, false, false), false);
  assert.equal(fit.serves(borrowed, false, true), true);
  assert.equal(fit.serves(roomy, false, false), true);
  assert.equal(fit.serves(reported, false, true), false);
  assert.equal(new ContextFit(demand(800, 400)).doubts(borrowed, true), false);
  fit.overflowed(roomy);
  assert.equal(fit.fits(reported, false), true);
  assert.equal(fit.short, false);
});

test("upstream context overflows are recognized across providers and nothing else is", () => {
  const overflows = [
    upstreamError(400, { error: { message: "This model's maximum context length is 8192 tokens.", code: "context_length_exceeded" } }),
    upstreamError(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }),
    upstreamError(400, { error: { message: "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000" } }),
    upstreamError(400, { error: { message: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)." } }),
    upstreamError(400, { error: { message: "This model's maximum prompt length is 131072 but the request contains 150000 tokens." } }),
    upstreamError(400, { error: { message: "Invalid request: Your request exceeded model token limit: 262144" } }),
    upstreamError(500, { error: { message: "the request exceeds the available context size, try increasing it" } }),
  ];
  for (const err of overflows) assert.equal(contextOverflow(err), true, err.message);
  const others = [
    upstreamError(429, { error: { message: "Request too large for gpt-4 in organization on tokens per min (TPM)", code: "rate_limit_exceeded" } }),
    upstreamError(401, { error: { message: "maximum context length is irrelevant without a key" } }),
    upstreamError(400, { error: { message: "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens" } }),
    upstreamError(429, { error: { message: "Long context requests require extra usage" } }),
    new GateError(400, "context_length_exceeded", "prompt is too long: 1 tokens > 0 maximum", { requestScoped: true }),
    new Error("context window"),
  ];
  for (const err of others) assert.equal(contextOverflow(err), false, err.message);
});

test("catalog facts keep the context length of every discovered model", () => {
  assert.deepEqual(
    factsByModel([{ id: "a", contextLength: 200_000 }, { id: "b", context_length: 8_192 }, { id: "c" }]),
    new Map([
      ["a", { contextLength: 200_000, contextSource: "reported" }],
      ["b", { contextLength: 8_192, contextSource: "reported" }],
    ]),
  );
});

test("a large prompt skips deployments whose context window is too small", async () => {
  const alias = sizedGroup([
    { model: "small", window: 1_000 },
    { model: "large", window: 100_000 },
  ]);
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["large"]);
  const fits = await post("/api/v1/chat/completions", chat(alias, 100));
  assert.equal(fits.status, 200);
  assert.deepEqual(upstreamModels(), ["large", "small"]);
});

test("unknown context windows never filter", async () => {
  const alias = sizedGroup([{ model: "unlisted", window: 0 }]);
  const res = await post("/api/v1/chat/completions", chat(alias, 50_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["unlisted"]);
});

test("a group too small for the prompt hands over to a fallback and then an overflow group with room", async () => {
  const roomy = sizedGroup([{ model: "roomy", window: 100_000 }]);
  const fallback = sizedGroup([{ model: "small", window: 1_000 }], { fallbackGroups: [roomy] });
  const res = await post("/api/v1/chat/completions", chat(fallback, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["roomy"]);
  gateway.upstream.length = 0;
  const wide = sizedGroup([{ model: "wide", window: 100_000 }]);
  const overflow = sizedGroup([{ model: "narrow", window: 1_000 }], { overflowGroup: wide });
  const spilled = await post("/api/v1/chat/completions", chat(overflow, 5_000));
  assert.equal(spilled.status, 200);
  assert.deepEqual(upstreamModels(), ["wide"]);
});

test("requested output tokens prefer a roomier fallback but never reject on their own", async () => {
  const roomy = sizedGroup([{ model: "roomy", window: 100_000 }]);
  const tight = sizedGroup([{ model: "tight", window: 3_000 }], { fallbackGroups: [roomy] });
  const preferred = await post("/api/v1/chat/completions", chat(tight, 2_000, { max_tokens: 2_000 }));
  assert.equal(preferred.status, 200);
  assert.deepEqual(upstreamModels(), ["roomy"]);
  gateway.upstream.length = 0;
  const alone = sizedGroup([{ model: "alone", window: 3_000 }]);
  const kept = await post("/api/v1/chat/completions", chat(alone, 2_000, { max_completion_tokens: 2_000 }));
  assert.equal(kept.status, 200);
  assert.deepEqual(upstreamModels(), ["alone"]);
});

test("groups that fit only without output wait until fully fitting fallbacks failed", async () => {
  const broken = sizedGroup([{ model: "broken", window: 100_000 }]);
  const tight = sizedGroup([{ model: "tight", window: 3_000 }], { fallbackGroups: [broken] });
  gateway.reply = (call) =>
    call.body?.model === "broken" ? Response.json({ error: { message: "upstream down" } }, { status: 500 }) : chatReply("ok");
  const res = await post("/api/v1/chat/completions", chat(tight, 2_000, { max_tokens: 2_000 }));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["broken", "tight"]);
});

test("a prompt that fits no deployment is rejected before any upstream call with its sizes", async () => {
  const fallback = sizedGroup([{ model: "medium", window: 2_000 }]);
  const alias = sizedGroup([{ model: "small", window: 1_000 }], { fallbackGroups: [fallback] });
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000, { max_tokens: 300 }));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-should-retry"), "false");
  const body = (await res.json()) as { error: { message: string; type: string; code: string; param: string } };
  assert.equal(body.error.code, "context_length_exceeded");
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.param, "messages");
  assert.match(body.error.message, /^prompt is too long: \d+ tokens > 2000 maximum/);
  assert.match(body.error.message, /300 requested output tokens/);
  assert.deepEqual(gateway.upstream, []);
});

test("Messages answer a prompt that fits nowhere in the Anthropic error shape", async () => {
  const alias = sizedGroup([{ model: "small", window: 1_000 }]);
  const res = await post("/api/v1/messages", {
    model: alias,
    max_tokens: 64,
    messages: [{ role: "user", content: words(5_000) }],
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /^prompt is too long: \d+ tokens > 1000 maximum/);
  assert.deepEqual(gateway.upstream, []);
});

test("Messages and Responses skip small context windows like chat completions", async () => {
  const alias = sizedGroup([
    { model: "small", window: 1_000 },
    { model: "large", window: 100_000 },
  ]);
  const messages = await post("/api/v1/messages", {
    model: alias,
    max_tokens: 64,
    messages: [{ role: "user", content: words(5_000) }],
  });
  assert.equal(messages.status, 200);
  const responses = await post("/api/v1/responses", { model: alias, input: words(5_000), store: false });
  assert.equal(responses.status, 200);
  assert.deepEqual(upstreamModels(), ["large", "large"]);
});

test("an upstream context overflow moves on to a fallback without cooling the deployment", async () => {
  const roomy = sizedGroup([{ model: "roomy", window: 0 }]);
  const alias = sizedGroup([{ model: "unlisted", window: 0 }], { fallbackGroups: [roomy] });
  gateway.reply = (call) =>
    call.body?.model === "unlisted"
      ? overflowReply("This model's maximum context length is 8192 tokens.", "context_length_exceeded")
      : chatReply("ok");
  const res = await post("/api/v1/chat/completions", chat(alias, 100));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["unlisted", "roomy"]);
  assert.deepEqual([...(await coolingDown([`${alias}-unlisted`]))], []);
});

test("an upstream context overflow with no larger fallback passes the provider error through", async () => {
  const alias = sizedGroup([{ model: "unlisted", window: 0 }]);
  gateway.reply = () => overflowReply("prompt is too long: 210000 tokens > 200000 maximum");
  const res = await post("/api/v1/messages", { model: alias, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.message, "prompt is too long: 210000 tokens > 200000 maximum");
  assert.deepEqual([...(await coolingDown([`${alias}-unlisted`]))], []);
});

test("a borrowed window that looks too small is tried after fitting routes, never dropped", async () => {
  const roomy = sizedGroup([{ model: "lent-roomy", window: 100_000 }]);
  const alias = sizedGroup([{ model: "lent-small", window: 1_000, borrowed: true }], { fallbackGroups: [roomy] });
  const preferred = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(preferred.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-roomy"]);
  gateway.upstream.length = 0;
  gateway.reply = (call) =>
    call.body?.model === "lent-roomy" ? Response.json({ error: { message: "upstream down" } }, { status: 500 }) : chatReply("ok");
  const deferred = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(deferred.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-roomy", "lent-small"]);
});

test("routes without a doubtful estimate go before a borrowed one in the same group", async () => {
  const alias = sizedGroup([
    { model: "lent-guess", window: 1_000, borrowed: true },
    { model: "lent-unlisted", window: 0 },
  ]);
  gateway.reply = (call) =>
    call.body?.model === "lent-unlisted" ? Response.json({ error: { message: "upstream down" } }, { status: 500 }) : chatReply("ok");
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-unlisted", "lent-guess"]);
  gateway.upstream.length = 0;
  gateway.reply = () => chatReply("ok");
  const small = await post("/api/v1/chat/completions", chat(alias, 100));
  assert.equal(small.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-guess"]);
});

test("a borrowed window is never the reason for an up-front refusal", async () => {
  const reported = sizedGroup([{ model: "lent-tiny", window: 1_000 }]);
  const alias = sizedGroup([{ model: "lent-only", window: 2_000, borrowed: true }], { fallbackGroups: [reported] });
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000, { max_tokens: 300 }));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-only"]);
  gateway.upstream.length = 0;
  gateway.reply = () => overflowReply("prompt is too long: 6000 tokens > 2000 maximum");
  const overflowed = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(overflowed.status, 400);
  const body = (await overflowed.json()) as { error: { message: string } };
  assert.equal(body.error.message, "prompt is too long: 6000 tokens > 2000 maximum");
  assert.deepEqual(upstreamModels(), ["lent-only"]);
});

test("a borrowed route stays in play after a reported sibling overflows and raises the size floor", async () => {
  const alias = sizedGroup(
    [
      { model: "floor-reported", window: 10_000 },
      { model: "floor-lent", window: 8_000, borrowed: true },
    ],
    { numRetries: 2 },
  );
  gateway.reply = (call) =>
    call.body?.model === "floor-reported"
      ? overflowReply("This model's maximum context length is 10000 tokens.", "context_length_exceeded")
      : chatReply("ok");
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["floor-reported", "floor-lent"]);
});

test("a group whose routes all look too small calls its overflow group once, then tries them", async () => {
  const wide = sizedGroup([{ model: "spill-wide", window: 100_000 }]);
  const alias = sizedGroup([{ model: "spill-lent", window: 1_000, borrowed: true }], { overflowGroup: wide });
  gateway.reply = (call) =>
    call.body?.model === "spill-wide" ? Response.json({ error: { message: "upstream down" } }, { status: 500 }) : chatReply("ok");
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["spill-wide", "spill-lent"]);
});

test("a borrowed window that fits routes like a reported one", async () => {
  const alias = sizedGroup([
    { model: "lent-wide", window: 100_000, borrowed: true },
    { model: "lent-narrow", window: 1_000 },
  ]);
  const res = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamModels(), ["lent-wide"]);
});

test("a route without a window borrows its group's reported window and is deferred when that looks too small", async () => {
  const fallback = sizedGroup([{ model: "peer-fallback", window: 100_000 }]);
  const alias = sizedGroup(
    [
      { model: "peer-guess", window: 0 },
      { model: "peer-known", window: 1_000 },
    ],
    { fallbackGroups: [fallback] },
  );
  const preferred = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(preferred.status, 200);
  assert.deepEqual(upstreamModels(), ["peer-fallback"]);
  gateway.upstream.length = 0;
  gateway.reply = (call) =>
    call.body?.model === "peer-fallback" ? Response.json({ error: { message: "upstream down" } }, { status: 500 }) : chatReply("ok");
  const deferred = await post("/api/v1/chat/completions", chat(alias, 5_000));
  assert.equal(deferred.status, 200);
  assert.deepEqual(upstreamModels(), ["peer-fallback", "peer-guess"]);
});
