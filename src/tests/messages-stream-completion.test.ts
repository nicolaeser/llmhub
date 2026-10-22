import { gateway, gatewayRequest, groupRow, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { seal } from "@/lib/crypto";
import type { JsonMap } from "@/types/gateway";

let counter = 0;

function anthropicGroup(): string {
  counter += 1;
  const alias = `claude-api-${counter}`;
  gateway.groups.set(
    alias,
    groupRow(alias, {
      vendor: "anthropic",
      deployments: [
        {
          id: `${alias}-route`,
          kind: "anthropic",
          baseUrl: "https://anthropic.upstream.test",
          model: "claude-test",
          weight: 1,
          costInput: 0,
          costOutput: 0,
          providerId: `${alias}-key`,
          provider: {
            id: `${alias}-key`,
            kind: "anthropic",
            baseUrl: "",
            apiKey: seal("sk-ant-test"),
            zdr: false,
            retentionDays: null,
            region: "",
            noTraining: false,
            enabled: true,
            restricted: false,
            assignments: [],
            login: null,
          },
        },
      ],
    }),
  );
  return alias;
}

function chatGroup(): string {
  counter += 1;
  const alias = `chat-${counter}`;
  gateway.groups.set(alias, groupRow(alias));
  return alias;
}

function sse(type: string, data: JsonMap): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const START = sse("message_start", {
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 40, output_tokens: 1 } },
});
const TEXT = [
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
];
const FINISH = [
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
  sse("message_stop", {}),
];

function stream(frames: string[], failure?: Error): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        if (failure) controller.error(failure);
        else controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function events(text: string): { event: string; data: JsonMap }[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as JsonMap };
    });
}

async function logged(): Promise<{ status: number; outcome: string }[]> {
  for (let wait = 0; wait < 400 && !recordedPrisma.called("requestLog", "create").length; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return recordedPrisma
    .called("requestLog", "create")
    .map((call) => (call.args as { data: { status: number; outcome: string } }).data)
    .map(({ status, outcome }) => ({ status, outcome }));
}

async function messages(alias: string, headers: Record<string, string> = {}, init: { signal?: AbortSignal } = {}) {
  const { POST } = await import("@/app/api/v1/messages/route");
  const request = gatewayRequest(
    "/api/v1/messages",
    { model: alias, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
    { "anthropic-version": "2023-06-01", ...headers },
  );
  return POST(init.signal ? new Request(request, { signal: init.signal }) : request);
}

beforeEach(() => {
  resetGateway();
});

test("a complete Messages stream is relayed unchanged and booked as success", async () => {
  const alias = anthropicGroup();
  gateway.reply = () => stream([START, ...TEXT, ...FINISH]);
  const res = await messages(alias);
  const seen = events(await res.text());
  assert.deepEqual(
    seen.map((item) => item.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.deepEqual(await logged(), [{ status: 200, outcome: "ok" }]);
});

test("a Messages stream that ends without message_stop ends with an error event and is booked as an error", async () => {
  const alias = anthropicGroup();
  gateway.reply = () => stream([START, ...TEXT]);
  const res = await messages(alias);
  assert.equal(res.status, 200);
  const seen = events(await res.text());
  assert.equal(seen.at(-1)?.event, "error");
  assert.deepEqual(seen.at(-1)?.data.error, { type: "api_error", message: "upstream stream ended before message_stop" });
  assert.equal(seen.filter((item) => item.event === "message_stop").length, 0);
  assert.deepEqual(await logged(), [{ status: 502, outcome: "error" }]);
});

test("a Messages stream whose upstream connection breaks ends with an error event instead of a cut stream", async () => {
  const alias = anthropicGroup();
  gateway.reply = () => stream([START, ...TEXT], new TypeError("terminated"));
  const res = await messages(alias);
  const seen = events(await res.text());
  assert.equal(seen.at(-1)?.event, "error");
  assert.equal((seen.at(-1)?.data.error as JsonMap).type, "api_error");
  assert.deepEqual(await logged(), [{ status: 502, outcome: "error" }]);
});

test("an upstream error event is forwarded once and books the request as an error", async () => {
  const alias = anthropicGroup();
  gateway.reply = () =>
    stream([START, ...TEXT, sse("error", { error: { type: "overloaded_error", message: "Overloaded" } })]);
  const res = await messages(alias);
  const seen = events(await res.text());
  const errors = seen.filter((item) => item.event === "error");
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]!.data.error, { type: "overloaded_error", message: "Overloaded" });
  assert.deepEqual(await logged(), [{ status: 502, outcome: "error" }]);
});

test("a chat completion stream that stops before finishing ends with an error chunk and [DONE]", async () => {
  const alias = chatGroup();
  gateway.reply = () =>
    stream([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] })}\n\n`,
    ]);
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const res = await POST(gatewayRequest("/api/v1/chat/completions", { model: alias, stream: true, messages: [{ role: "user", content: "hi" }] }));
  const frames = (await res.text()).split("\n\n").map((frame) => frame.trim()).filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");
  const error = JSON.parse(frames.at(-2)!.slice("data:".length)) as { error: { code: string; message: string } };
  assert.equal(error.error.code, "upstream_error");
  assert.match(error.error.message, /ended before the response was complete/);
  assert.deepEqual(await logged(), [{ status: 502, outcome: "error" }]);
});

test("a chat completion stream that finishes without [DONE] still counts as complete", async () => {
  const alias = chatGroup();
  gateway.reply = () =>
    stream([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    ]);
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const res = await POST(gatewayRequest("/api/v1/chat/completions", { model: alias, stream: true, messages: [{ role: "user", content: "hi" }] }));
  const text = await res.text();
  assert.doesNotMatch(text, /"error"/);
  assert.deepEqual(await logged(), [{ status: 200, outcome: "ok" }]);
});

test("a client that cancels before the upstream answers is logged as cancelled without cooling the key", async () => {
  const alias = anthropicGroup();
  const client = new AbortController();
  let calls = 0;
  gateway.reply = () => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      setTimeout(() => {
        client.abort();
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, 5);
    });
  };
  const res = await messages(alias, {}, { signal: client.signal });
  assert.equal(res.status, 499);
  assert.equal(calls, 1);
  assert.deepEqual(await logged(), [{ status: 499, outcome: "cancelled" }]);
  const usage = recordedPrisma.called("usageDaily", "upsert")[0]!.args as { create: { errors: number; requests: number } };
  assert.equal(usage.create.requests, 1);
  assert.equal(usage.create.errors, 0);
  const { cooldownEnds } = await import("@/lib/gateway/routing/provider-health");
  assert.equal((await cooldownEnds([`${alias}-route`])).size, 0);
});

function openStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function hangUpAfterFirstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(first.value);
}

function bookedUsage(): { requests: number; errors: number; promptTokens: number } {
  return (recordedPrisma.called("usageDaily", "upsert")[0]!.args as { create: { requests: number; errors: number; promptTokens: number } }).create;
}

test("a client that hangs up during a Messages stream is booked as cancelled with the tokens streamed so far", async () => {
  const alias = anthropicGroup();
  gateway.reply = () => openStream([START, ...TEXT]);
  const res = await messages(alias);
  assert.equal(res.status, 200);
  assert.match(await hangUpAfterFirstChunk(res), /message_start/);
  assert.deepEqual(await logged(), [{ status: 499, outcome: "cancelled" }]);
  const usage = bookedUsage();
  assert.equal(usage.requests, 1);
  assert.equal(usage.errors, 0);
  assert.equal(usage.promptTokens, 40);
});

test("a client that hangs up during a chat completion stream is booked as cancelled", async () => {
  const alias = chatGroup();
  gateway.reply = () =>
    openStream([
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] })}\n\n`,
    ]);
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const res = await POST(gatewayRequest("/api/v1/chat/completions", { model: alias, stream: true, messages: [{ role: "user", content: "hi" }] }));
  assert.match(await hangUpAfterFirstChunk(res), /Hel/);
  assert.deepEqual(await logged(), [{ status: 499, outcome: "cancelled" }]);
  assert.equal(bookedUsage().errors, 0);
});

function imageEvent(type: string, data: JsonMap): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const PARTIAL_IMAGE = imageEvent("image_generation.partial_image", { partial_image_index: 0, b64_json: "AAAA" });
const COMPLETED_IMAGE = imageEvent("image_generation.completed", { b64_json: "BBBB", usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 } });

async function imageStream() {
  const { POST } = await import("@/app/api/v1/images/generations/route");
  return POST(gatewayRequest("/api/v1/images/generations", { model: chatGroup(), prompt: "a lighthouse", stream: true, partial_images: 1 }));
}

test("a complete image stream is booked as success with its usage", async () => {
  gateway.reply = () => stream([PARTIAL_IMAGE, COMPLETED_IMAGE]);
  const res = await imageStream();
  assert.match(await res.text(), /image_generation\.completed/);
  assert.deepEqual(await logged(), [{ status: 200, outcome: "ok" }]);
  assert.equal(bookedUsage().promptTokens, 12);
});

test("an image stream whose upstream connection breaks is booked as an error", async () => {
  gateway.reply = () => stream([PARTIAL_IMAGE], new TypeError("terminated"));
  const res = await imageStream();
  await res.text().catch(() => "");
  assert.deepEqual(await logged(), [{ status: 502, outcome: "error" }]);
  assert.equal(bookedUsage().errors, 1);
});

test("a client that hangs up during an image stream is booked as cancelled", async () => {
  gateway.reply = () => openStream([PARTIAL_IMAGE]);
  const res = await imageStream();
  assert.match(await hangUpAfterFirstChunk(res), /partial_image/);
  assert.deepEqual(await logged(), [{ status: 499, outcome: "cancelled" }]);
  assert.equal(bookedUsage().errors, 0);
});

test("a rate limited count_tokens call falls back to the local estimate and never cools the key", async () => {
  const alias = anthropicGroup();
  gateway.reply = () =>
    Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      { status: 429, headers: { "retry-after": "600" } },
    );
  const { POST } = await import("@/app/api/v1/messages/count_tokens/route");
  const body = { model: alias, max_tokens: 16, messages: [{ role: "user", content: "count these words please" }] };
  for (let round = 0; round < 3; round++) {
    const res = await POST(gatewayRequest("/api/v1/messages/count_tokens", body, { "anthropic-version": "2023-06-01" }));
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { input_tokens: number }).input_tokens > 0);
  }
  assert.equal(gateway.upstream.filter((call) => call.url.endsWith("/v1/messages/count_tokens")).length, 3);
  const { cooldownEnds } = await import("@/lib/gateway/routing/provider-health");
  assert.equal((await cooldownEnds([`${alias}-route`])).size, 0);
  gateway.reply = () => Response.json({ input_tokens: 1234 });
  const counted = await POST(gatewayRequest("/api/v1/messages/count_tokens", body, { "anthropic-version": "2023-06-01" }));
  assert.equal(((await counted.json()) as { input_tokens: number }).input_tokens, 1234);
});
