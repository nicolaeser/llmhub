import { gateway, gatewayRequest, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { sealTokens } from "@/lib/gateway/upstreams/credentials";

const ALIAS = "claude-stream";

function claudeGroup() {
  return {
    alias: ALIAS,
    enabled: true,
    vendor: "anthropic",
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
        kind: "claude",
        baseUrl: "",
        model: "claude-sonnet-4-6",
        weight: 1,
        costInput: 0,
        costOutput: 0,
        providerId: "provider-claude",
        provider: {
          id: "provider-claude",
          kind: "claude",
          baseUrl: "",
          apiKey: "",
          zdr: false,
          retentionDays: null,
          region: "",
          noTraining: false,
          enabled: true,
          restricted: false,
          assignments: [],
          login: { status: "active" },
        },
      },
    ],
  };
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const UPSTREAM_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1200,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
];

async function streamBody(): Promise<string> {
  resetGateway();
  gateway.groups.clear();
  gateway.groups.set(ALIAS, claudeGroup());
  recordedPrisma.handlers = {
    providerLogin: {
      findUnique: () => ({
        providerId: "provider-claude",
        account: "test-account",
        plan: "Max",
        tokens: sealTokens({ access: "sk-ant-oat-test", refresh: "refresh-test", accountId: "", residency: "" }),
        expiresAt: new Date(Date.now() + 3_600_000),
        status: "active",
        version: 1,
      }),
    },
  };
  gateway.reply = (call) =>
    call.url.includes("/oauth/usage") ? Response.json({}) : sseResponse(UPSTREAM_FRAMES);
  const { POST } = await import("@/app/api/subscription/v1/chat/completions/route");
  const res = await POST(
    gatewayRequest(`/api/subscription/v1/chat/completions`, {
      model: ALIAS,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  return await res.text();
}

test("a failing subscription chat stream ends with an error chunk and [DONE]", async () => {
  const text = await streamBody();
  const frames = text.split("\n\n").map((frame) => frame.trim()).filter(Boolean);
  assert.ok(frames.length >= 2, text);
  const last = frames.at(-1)!;
  assert.equal(last, "data: [DONE]");
  const errors = frames.filter((frame) => frame.includes('"error"'));
  assert.equal(errors.length, 1, text);
  const payload = JSON.parse(errors[0]!.slice("data:".length).trim()) as {
    error: { message: string; type: string; param: unknown; code: string };
  };
  assert.equal(payload.error.message, "Overloaded");
  assert.equal(payload.error.code, "upstream_error");
});

test("a failing subscription chat stream is metered as an error, not a 200 success", async () => {
  await streamBody();
  const logs = recordedPrisma.called("requestLog", "create");
  assert.equal(logs.length, 1);
  const data = (logs[0]!.args as { data: { status: number; outcome: string; model: string } }).data;
  assert.equal(data.model, ALIAS);
  assert.equal(data.status, 502);
  assert.equal(data.outcome, "error");
});
