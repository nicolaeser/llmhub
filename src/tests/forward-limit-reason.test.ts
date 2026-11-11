import { gateway, gatewayRequest, groupRow, resetGateway } from "./support/gateway-harness";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const GOOGLE_MESSAGE = "You exceeded your current quota, please check your plan and billing details.";
const HUB_SENTENCE = /^all deployments for this model are rate limited; the next one is available again at \S+ \(in 1m\)$/;
const PROVIDER_SUFFIX = `; the provider answered: ${GOOGLE_MESSAGE}`;

let counter = 0;
let alias = "";

beforeEach(() => {
  resetGateway();
  counter += 1;
  alias = `forward-reason-${counter}`;
});

afterEach(() => {
  gateway.groups.delete(alias);
  gateway.groups.delete(secondOf(alias));
});

function secondOf(name: string): string {
  return `${name}-second`;
}

function serve(name: string, numRetries: number): void {
  gateway.groups.set(name, groupRow(name, { numRetries }));
}

function googleLimit(retryDelay = "37s"): Response {
  return Response.json(
    {
      error: {
        code: 429,
        message: GOOGLE_MESSAGE,
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }],
      },
    },
    { status: 429 },
  );
}

function refusal(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

async function postEmbeddings(model = alias): Promise<Response> {
  const { POST } = await import("@/app/api/v1/embeddings/route");
  return POST(gatewayRequest("/api/v1/embeddings", { model, input: "hi" }));
}

async function errorOf(res: Response): Promise<{ message: string; code: string }> {
  const json = (await res.json()) as { error: { message: string; code: string } };
  return json.error;
}

function retrySeconds(res: Response): number {
  return Number(res.headers.get("retry-after"));
}

test("an embedding refused for quota names the provider's message after the hub sentence", async () => {
  serve(alias, 1);
  gateway.reply = () => googleLimit();
  const res = await postEmbeddings();
  assert.equal(gateway.upstream.length, 1);
  assert.equal(res.status, 429);
  assert.ok(retrySeconds(res) >= 36 && retrySeconds(res) <= 45, `retry-after ${retrySeconds(res)}`);
  const error = await errorOf(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.ok(error.message.endsWith(PROVIDER_SUFFIX), error.message);
  assert.match(error.message.slice(0, -PROVIDER_SUFFIX.length), HUB_SENTENCE);
});

test("an embedding refused without a wait keeps the provider's own refusal", async () => {
  serve(alias, 2);
  gateway.reply = () => refusal(429, "Too many embedding requests.");
  const res = await postEmbeddings();
  assert.equal(gateway.upstream.length, 2);
  assert.equal(res.status, 429);
  const error = await errorOf(res);
  assert.equal(error.code, "upstream_error");
  assert.equal(error.message, "Too many embedding requests.");
});

test("an embedding whose upstream keeps failing answers the upstream's failure", async () => {
  serve(alias, 2);
  gateway.reply = () => refusal(500, "embedding backend failed");
  const res = await postEmbeddings();
  assert.equal(gateway.upstream.length, 2);
  assert.equal(res.status, 500);
  const error = await errorOf(res);
  assert.equal(error.code, "upstream_error");
  assert.equal(error.message, "embedding backend failed");
});

test("an embedding that meets a quota cooldown gets the hub sentence without provider words", async () => {
  serve(alias, 1);
  gateway.reply = () => googleLimit();
  await postEmbeddings();
  gateway.upstream.length = 0;
  const res = await postEmbeddings();
  assert.equal(gateway.upstream.length, 0);
  assert.equal(res.status, 429);
  assert.ok(retrySeconds(res) >= 36 && retrySeconds(res) <= 45, `retry-after ${retrySeconds(res)}`);
  const error = await errorOf(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.match(error.message, HUB_SENTENCE);
});

test("an embedding that meets a short cooldown is told when to retry", async () => {
  serve(alias, 1);
  gateway.reply = () => refusal(500, "embedding backend failed");
  await postEmbeddings();
  gateway.upstream.length = 0;
  const res = await postEmbeddings();
  assert.equal(gateway.upstream.length, 0);
  assert.equal(res.status, 503);
  assert.ok(retrySeconds(res) >= 1 && retrySeconds(res) <= 20, `retry-after ${retrySeconds(res)}`);
  const error = await errorOf(res);
  assert.equal(error.code, "no_healthy_deployment");
});

test("a second model that was already cooling never carries the first model's provider message", async () => {
  const { forwardToModel } = await import("@/lib/gateway/dispatch/upstream");
  const { systemPrincipal } = await import("@/lib/gateway/access/system-principal");
  const { GateError } = await import("@/lib/gateway/errors");
  const second = secondOf(alias);
  serve(alias, 0);
  serve(second, 0);
  gateway.reply = (call) => (call.body?.model === second ? googleLimit("120s") : googleLimit());
  await postEmbeddings(second);
  gateway.upstream.length = 0;
  const failure = await forwardToModel([alias, second], systemPrincipal("model_test"), "/embeddings", { model: alias, input: "hi" }, {
    pool: "internal",
  }).then(
    () => null,
    (err: unknown) => err,
  );
  assert.deepEqual(
    gateway.upstream.map((call) => call.body?.model),
    [alias],
  );
  assert.ok(failure instanceof GateError);
  assert.equal(failure.status, 429);
  assert.equal(failure.code, "rate_limit_exceeded");
  assert.match(
    failure.message,
    /^all deployments for this model are rate limited; the next one is available again at \S+ \(in 2m\)$/,
  );
});

test("a long provider wait never hides a deployment that is back within seconds", async () => {
  const first = `${alias}-a`;
  const second = `${alias}-b`;
  const route = (model: string) => ({ ...groupRow(alias).deployments[0]!, id: `${model}-route`, model });
  gateway.groups.set(alias, groupRow(alias, { numRetries: 3, deployments: [route(first), route(second)] }));
  gateway.reply = (call) => (call.body?.model === first ? refusal(500, "embedding backend failed") : googleLimit("7200s"));
  const res = await postEmbeddings();
  assert.deepEqual(
    gateway.upstream.map((call) => call.body?.model),
    [first, first, second],
  );
  assert.equal(res.status, 503);
  assert.ok(retrySeconds(res) >= 1 && retrySeconds(res) <= 20, `retry-after ${retrySeconds(res)}`);
  assert.equal(res.headers.get("x-should-retry"), "true");
  const error = await errorOf(res);
  assert.equal(error.code, "no_healthy_deployment");
});

test("speech refused for quota answers like an embedding", async () => {
  const { POST } = await import("@/app/api/v1/audio/speech/route");
  serve(alias, 1);
  gateway.reply = () => googleLimit();
  const res = await POST(gatewayRequest("/api/v1/audio/speech", { model: alias, input: "hi", voice: "alloy" }));
  assert.equal(gateway.upstream.length, 1);
  assert.equal(res.status, 429);
  const error = await errorOf(res);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.ok(error.message.endsWith(PROVIDER_SUFFIX), error.message);
});

test("an embedding refused for missing credit still answers the provider's refusal", async () => {
  serve(alias, 1);
  gateway.reply = () => refusal(402, "Your credit balance is too low.");
  const res = await postEmbeddings();
  assert.equal(res.status, 402);
  const error = await errorOf(res);
  assert.equal(error.message, "Your credit balance is too low.");
});

test("the shown provider reason follows one rule for callers and alerts", async () => {
  const { RouterError, routerGateError, withProviderReason } = await import("@/lib/gateway/core");
  const { GateError } = await import("@/lib/gateway/errors");
  const words = "Quota exceeded for metric embed_content.";
  const limited = { retryAt: Date.now() + 2 * 3_600_000, limited: true, kinds: [] as string[] };
  const shown = new RouterError("router: every deployment is rate limited", "no_healthy", limited, words);
  assert.equal(withProviderReason(shown.message, shown), `router: every deployment is rate limited; the provider answered: ${words}`);
  assert.ok(routerGateError(shown)!.message.endsWith(`; the provider answered: ${words}`));
  const pooled = new RouterError("router: every deployment is rate limited", "no_healthy", { ...limited, kinds: ["codex"] }, words);
  assert.equal(withProviderReason(pooled.message, pooled), pooled.message);
  assert.ok(!routerGateError(pooled)!.message.includes(words));
  const cooling = new RouterError("router: every deployment is cooling down", "no_healthy", { ...limited, limited: false }, words);
  assert.equal(withProviderReason(cooling.message, cooling), cooling.message);
  const wordless = new RouterError("router: every deployment is rate limited", "no_healthy", limited);
  assert.equal(withProviderReason(wordless.message, wordless), wordless.message);
  assert.equal(withProviderReason("upstream failure", new GateError(429, "upstream_error", words)), "upstream failure");
});
