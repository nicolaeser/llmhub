import { gateway, gatewayRequest, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { sealTokens } from "@/lib/gateway/upstreams/credentials";

const ALIAS = "gpt-relay";

function codexGroup() {
  return {
    alias: ALIAS,
    enabled: true,
    vendor: "openai",
    displayName: "",
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    autoRoutes: null,
    deployments: [
      {
        id: `${ALIAS}-route`,
        kind: "codex",
        baseUrl: "",
        model: "gpt-5.6-terra",
        weight: 1,
        costInput: 0,
        costOutput: 0,
        providerId: "provider-codex",
        provider: {
          id: "provider-codex",
          kind: "codex",
          baseUrl: "",
          apiKey: "",
          zdr: false,
          retentionDays: null,
          region: "",
          noTraining: false,
          enabled: true,
          restricted: false,
          assignments: [],
        },
      },
    ],
  };
}

function frame(type: string, body: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

const CODEX_FRAMES = [
  frame("response.created", { response: { id: "resp_1", model: "gpt-5.6-terra", output: [] } }),
  frame("response.in_progress", { response: { id: "resp_1" } }),
  ": keep-alive\n\n",
  frame("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
  frame("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
  frame("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Thinking" }),
  frame("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Thinking" }] } }),
  frame("response.output_item.added", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
  frame("response.content_part.added", { item_id: "msg_1", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } }),
  frame("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hi" }),
  frame("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: " there" }),
  frame("response.output_text.done", { item_id: "msg_1", output_index: 1, content_index: 0, text: "Hi there" }),
  frame("response.output_item.done", { output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi there" }] } }),
  frame("response.completed", {
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } },
  }),
];

function trickle(frames: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (index >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(frames[index]!));
        index += 1;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function setup() {
  resetGateway();
  gateway.groups.clear();
  gateway.groups.set(ALIAS, codexGroup());
  recordedPrisma.handlers = {
    providerLogin: {
      findUnique: () => ({
        providerId: "provider-codex",
        account: "test@example.com",
        plan: "plus",
        tokens: sealTokens({ access: "codex-access", refresh: "codex-refresh", accountId: "acct-1", residency: "" }),
        expiresAt: new Date(Date.now() + 3_600_000),
        status: "active",
        version: 1,
      }),
    },
  };
  gateway.reply = (call) => (call.url.includes("/responses") ? trickle(CODEX_FRAMES) : Response.json({}));
}

test("a codex stream whose events map to nothing keeps flowing to a chat client", { timeout: 5000 }, async () => {
  setup();
  const { POST } = await import("@/app/api/subscription/v1/chat/completions/route");
  const res = await POST(
    gatewayRequest(`/api/subscription/v1/chat/completions`, {
      model: ALIAS,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"content":"Hi"/);
  assert.match(text, /"content":" there"/);
  assert.match(text, /data: \[DONE\]/);
});

test("Claude Code gets a complete Anthropic stream from a codex deployment", { timeout: 5000 }, async () => {
  setup();
  const { POST } = await import("@/app/api/subscription/v1/messages/route");
  const res = await POST(
    gatewayRequest(`/api/subscription/v1/messages`, {
      model: `anthropic/${ALIAS}`,
      max_tokens: 32000,
      stream: true,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    }),
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = [...text.matchAll(/^event: (\S+)$/gm)].map((match) => match[1]);
  assert.equal(events[0], "message_start");
  assert.ok(events.includes("content_block_delta"), text);
  assert.equal(events.at(-1), "message_stop", text);
  assert.match(text, /"thinking":"Thinking"/);
  assert.match(text, /"text":"Hi"/);
});

test("Claude Code token counting works on the subscription surface without an upstream call", { timeout: 5000 }, async () => {
  setup();
  let upstreamCalls = 0;
  gateway.reply = () => {
    upstreamCalls += 1;
    return Response.json({});
  };
  const { POST } = await import("@/app/api/subscription/v1/messages/count_tokens/route");
  const res = await POST(
    gatewayRequest(`/api/subscription/v1/messages/count_tokens`, {
      model: `anthropic/${ALIAS}`,
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "Count these tokens please" }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { input_tokens: number };
  assert.ok(body.input_tokens > 0);
  assert.equal(upstreamCalls, 0);
});

test("Codex CLI hosted web search reaches a codex deployment and earlier search items are accepted", { timeout: 5000 }, async () => {
  setup();
  const bodies: Record<string, unknown>[] = [];
  gateway.reply = (call) => {
    if (call.body) bodies.push(call.body);
    return call.url.includes("/responses") ? trickle(CODEX_FRAMES) : Response.json({});
  };
  const { POST } = await import("@/app/api/subscription/v1/responses/route");
  const res = await POST(
    gatewayRequest(`/api/subscription/v1/responses`, {
      model: ALIAS,
      stream: true,
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "news?" }] },
        { type: "web_search_call", id: "ws_0", status: "completed", action: { type: "search", query: "old" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      ],
      tools: [{ type: "web_search", external_web_access: true }],
    }),
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /response\.completed/);
  const upstream = bodies.find((body) => Array.isArray(body.tools));
  assert.ok(upstream, JSON.stringify(bodies));
  assert.deepEqual(upstream.tools, [{ type: "web_search" }]);
  assert.deepEqual(upstream.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
});
