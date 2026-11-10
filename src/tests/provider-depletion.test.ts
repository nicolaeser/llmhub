import { chatReply, gateway, gatewayRequest, groupRow, MODEL, resetGateway } from "./support/gateway-harness";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { providerDepleted } from "@/lib/gateway/dispatch/upstream";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap } from "@/types/gateway";

const CREDIT_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

let counter = 0;
let alias = "";

function route(id: string, weight: number) {
  return {
    id,
    kind: "openai_compat",
    baseUrl: `https://${id}.test/v1`,
    model: MODEL,
    weight,
    costInput: 0,
    costOutput: 0,
    providerId: null,
    provider: null,
  };
}

function depletedReply(): Response {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message: CREDIT_MESSAGE } }, { status: 400 });
}

function hosts(): string[] {
  return gateway.upstream.map((call) => new URL(call.url).hostname.replace(/\.test$/, ""));
}

function routes(...names: string[]): string[] {
  return names.map((name) => `${alias}-${name}`);
}

beforeEach(() => {
  resetGateway();
  counter += 1;
  alias = `depleted-${counter}`;
  gateway.groups.set(
    alias,
    groupRow(alias, { deployments: [route(`${alias}-a`, 30), route(`${alias}-b`, 20), route(`${alias}-c`, 10)] }),
  );
});

afterEach(() => {
  gateway.groups.delete(alias);
});

async function postChat(model = alias): Promise<Response> {
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  return POST(gatewayRequest("/api/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] }));
}

test("credit, billing, and quota refusals count as a depleted provider", () => {
  assert.equal(providerDepleted(new GateError(400, "upstream_error", CREDIT_MESSAGE)), true);
  assert.equal(providerDepleted(new GateError(402, "upstream_error", "Insufficient credits")), true);
  assert.equal(
    providerDepleted(new GateError(429, "upstream_error", "You exceeded your current quota.", { upstreamCode: "insufficient_quota" })),
    true,
  );
  assert.equal(providerDepleted(new GateError(403, "upstream_error", "Insufficient balance on this account")), true);
  assert.equal(providerDepleted(new GateError(400, "upstream_error", "messages: field required")), false);
  assert.equal(providerDepleted(new GateError(429, "upstream_error", "Rate limit reached")), false);
  assert.equal(providerDepleted(new GateError(402, "upstream_error", "Insufficient credits", { requestScoped: true })), false);
  assert.equal(providerDepleted(new Error(CREDIT_MESSAGE)), false);
});

test("a provider without credit hands the request to the next provider even without retries", async () => {
  gateway.reply = (call) => (call.url.startsWith(`https://${alias}-a.`) ? depletedReply() : chatReply("ok"));
  const res = await postChat();
  assert.equal(res.status, 200);
  assert.deepEqual(hosts(), routes("a", "b"));
});

test("the next request skips a provider that ran out of credit", async () => {
  gateway.reply = (call) => (call.url.startsWith(`https://${alias}-a.`) ? depletedReply() : chatReply("ok"));
  await postChat();
  gateway.upstream.length = 0;
  const res = await postChat();
  assert.equal(res.status, 200);
  assert.deepEqual(hosts(), routes("b"));
});

test("when every provider is out of credit the caller gets the provider's message", async () => {
  gateway.reply = () => depletedReply();
  const res = await postChat();
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: JsonMap };
  assert.equal(body.error.message, CREDIT_MESSAGE);
  assert.deepEqual(hosts(), routes("a", "b", "c"));
});

test("errors that are the caller's fault still stop at the first provider", async () => {
  gateway.reply = () =>
    Response.json({ error: { type: "invalid_request_error", message: "messages: field required" } }, { status: 400 });
  const res = await postChat();
  assert.equal(res.status, 400);
  assert.deepEqual(hosts(), routes("a"));
});

test("non-chat endpoints also move past a provider without credit", async () => {
  gateway.reply = (call) =>
    call.url.startsWith(`https://${alias}-a.`)
      ? Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })
      : Response.json({ object: "list", data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
  const { POST } = await import("@/app/api/v1/embeddings/route");
  const res = await POST(gatewayRequest("/api/v1/embeddings", { model: alias, input: "hi" }));
  assert.equal(res.status, 200);
  assert.deepEqual(hosts(), routes("a", "b"));
});

test("non-chat endpoints report the credit error once every provider is out", async () => {
  gateway.reply = () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 });
  const { POST } = await import("@/app/api/v1/embeddings/route");
  const res = await POST(gatewayRequest("/api/v1/embeddings", { model: alias, input: "hi" }));
  assert.equal(res.status, 402);
  assert.equal(((await res.json()) as { error: JsonMap }).error.message, "Insufficient credits");
  assert.deepEqual(hosts(), routes("a", "b", "c"));
});
