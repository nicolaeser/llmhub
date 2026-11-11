import { gateway, gatewayRequest, groupRow, resetGateway } from "./support/gateway-harness";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { JsonMap } from "@/types/gateway";

const GOOGLE_MESSAGE = "You exceeded your current quota, please check your plan and billing details.";
const GOOGLE_LIMIT = {
  error: {
    code: 429,
    message: GOOGLE_MESSAGE,
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
  },
};
const HUB_SENTENCE = /^all deployments for this model are rate limited; the next one is available again at \S+ \(in 1m\)$/;
const PROVIDER_SUFFIX = `; the provider answered: ${GOOGLE_MESSAGE}`;

let counter = 0;
let alias = "";

beforeEach(() => {
  resetGateway();
  counter += 1;
  alias = `limit-reason-${counter}`;
  gateway.groups.set(alias, groupRow(alias, { numRetries: 1 }));
});

afterEach(() => {
  gateway.groups.delete(alias);
  gateway.groups.delete(fallbackOf(alias));
});

function fallbackOf(name: string): string {
  return `${name}-fallback`;
}

function googleLimit(): Response {
  return Response.json(GOOGLE_LIMIT, { status: 429 });
}

async function postChat(extra: JsonMap = {}): Promise<Response> {
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  return POST(gatewayRequest("/api/v1/chat/completions", { model: alias, messages: [{ role: "user", content: "hi" }], ...extra }));
}

async function postMessages(): Promise<Response> {
  const { POST } = await import("@/app/api/v1/messages/route");
  return POST(
    gatewayRequest("/api/v1/messages", { model: alias, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  );
}

async function openAIError(res: Response): Promise<{ message: string; type: string; code: string }> {
  const json = (await res.json()) as { error: { message: string; type: string; code: string } };
  return json.error;
}

async function anthropicError(res: Response): Promise<{ message: string; type: string }> {
  const json = (await res.json()) as { type: string; error: { message: string; type: string } };
  assert.equal(json.type, "error");
  return json.error;
}

function assertRetryHeaders(res: Response): void {
  const seconds = Number(res.headers.get("retry-after"));
  assert.ok(seconds >= 36 && seconds <= 45, `retry-after ${seconds}`);
  assert.equal(res.headers.get("x-should-retry"), "true");
}

function withoutSuffix(message: string): string {
  assert.ok(message.endsWith(PROVIDER_SUFFIX), message);
  return message.slice(0, -PROVIDER_SUFFIX.length);
}

test("a retried quota refusal names the provider's own message after the hub sentence", async () => {
  gateway.reply = () => googleLimit();
  const res = await postChat();
  assert.equal(gateway.upstream.length, 1);
  assert.equal(res.status, 429);
  assertRetryHeaders(res);
  const error = await openAIError(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.equal(error.type, "rate_limit_error");
  assert.match(withoutSuffix(error.message), HUB_SENTENCE);
});

test("a request answered from the existing cooldown keeps the plain hub sentence", async () => {
  gateway.reply = () => googleLimit();
  await postChat();
  gateway.upstream.length = 0;
  const res = await postChat();
  assert.equal(gateway.upstream.length, 0);
  assert.equal(res.status, 429);
  assertRetryHeaders(res);
  const error = await openAIError(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.match(error.message, HUB_SENTENCE);
});

test("the Anthropic error shape carries the provider's message the same way", async () => {
  gateway.reply = () => googleLimit();
  const res = await postMessages();
  assert.equal(gateway.upstream.length, 1);
  assert.equal(res.status, 429);
  assertRetryHeaders(res);
  const error = await anthropicError(res);
  assert.equal(error.type, "rate_limit_error");
  assert.match(withoutSuffix(error.message), HUB_SENTENCE);
});

const RETRY_AFTER = { "retry-after": "37" };

const WORDLESS_LIMITS: { name: string; reply: () => Response; body?: JsonMap }[] = [
  { name: "an empty body", reply: () => new Response("", { status: 429, headers: RETRY_AFTER }) },
  {
    name: "an error body without a message",
    reply: () => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429, headers: RETRY_AFTER }),
  },
  {
    name: "an empty body on a stream",
    reply: () => new Response("", { status: 429, headers: RETRY_AFTER }),
    body: { stream: true },
  },
  {
    name: "a markup body on a stream",
    reply: () =>
      new Response("<html><body><h1>429 Too Many Requests</h1></body></html>", {
        status: 429,
        headers: { ...RETRY_AFTER, "content-type": "text/html" },
      }),
    body: { stream: true },
  },
];

for (const wordless of WORDLESS_LIMITS) {
  test(`a quota refusal with ${wordless.name} leaves the hub sentence plain`, async () => {
    gateway.reply = wordless.reply;
    const res = await postChat(wordless.body);
    assert.equal(gateway.upstream.length, 1);
    assert.equal(res.status, 429);
    assertRetryHeaders(res);
    const error = await openAIError(res);
    assert.equal(error.code, "rate_limit_exceeded");
    assert.match(error.message, HUB_SENTENCE);
  });
}

test("a request-scoped refusal still reaches the caller unchanged", async () => {
  const refusal = "Fast request rejected: usage credits are required for fast mode.";
  gateway.reply = () => Response.json({ error: { message: refusal, type: "rate_limit_error" } }, { status: 429 });
  const res = await postChat();
  assert.equal(gateway.upstream.length, 1);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-should-retry"), "false");
  assert.equal(res.headers.get("retry-after"), null);
  const error = await openAIError(res);
  assert.equal(error.message, refusal);
  assert.equal(error.code, "upstream_error");
});

test("a fallback model that was already cooling never carries the first model's provider message", async () => {
  const fallback = fallbackOf(alias);
  const firstWords = "first provider quota words";
  gateway.groups.set(fallback, groupRow(fallback));
  gateway.groups.set(alias, groupRow(alias, { fallbackGroups: [fallback] }));
  gateway.reply = (call) =>
    call.body?.model === fallback
      ? Response.json(
          { error: { ...GOOGLE_LIMIT.error, details: [{ ...GOOGLE_LIMIT.error.details[0], retryDelay: "120s" }] } },
          { status: 429 },
        )
      : Response.json({ error: { message: firstWords } }, { status: 429, headers: RETRY_AFTER });
  await postChat({ model: fallback });
  gateway.upstream.length = 0;
  const res = await postChat();
  assert.deepEqual(
    gateway.upstream.map((call) => call.body?.model),
    [alias],
  );
  assert.equal(res.status, 429);
  const error = await openAIError(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.match(error.message, /^all deployments for this model are rate limited; the next one is available again at \S+ \(in 2m\)$/);
});

test("an account pool keeps its aggregate sentence while a mixed pool names the provider's message", async () => {
  const { RouterError, routerGateError } = await import("@/lib/gateway/core");
  const words = "Usage limit reached until 18:00.";
  const wait = { retryAt: Date.now() + 2 * 3_600_000, limited: true, kinds: ["codex"] };
  const pooled = routerGateError(new RouterError("limited", "no_healthy", wait, words));
  assert.match(pooled!.message, /^all ChatGPT subscription \(Codex\) accounts have reached their usage limit; .* \(in 2h\)$/);
  const mixed = routerGateError(new RouterError("limited", "no_healthy", { ...wait, kinds: [] }, words));
  assert.match(mixed!.message, /^all deployments for this model are rate limited; .* \(in 2h\); the provider answered: Usage limit reached until 18:00\.$/);
});
