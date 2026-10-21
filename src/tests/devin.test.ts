import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test, { afterEach, beforeEach } from "node:test";
import {
  DEVIN_SESSION_EXPIRES_AT,
  devinHeaders,
  devinLimits,
  devinSession,
  formatSessionToken,
  parseDevinStatus,
  pastedSessionToken,
  windowReset,
} from "@/lib/gateway/upstreams/devin-account";
import {
  cleanDevinDisplayName,
  devinModels,
  devinModelUid,
  normalizeDevinEffort,
  parseDevinModelConfigs,
  splitDevinUid,
} from "@/lib/gateway/upstreams/devin-models";
import {
  chatToDevin,
  decodeToolCallId,
  devinCompletion,
  devinEventStream,
  devinHttpError,
  devinQuotaWindow,
  DevinChatTranslator,
  devinSignature,
  dimensionUsage,
  encodeDevinRequest,
  encodeToolCallId,
  parseDevinSignature,
  parseDevinTrailer,
} from "@/lib/gateway/upstreams/devin";
import {
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  ConnectFrameReader,
  ProtoWriter,
  connectEnvelope,
  connectFrames,
  protoDouble,
  protoFields,
  protoNumber,
  protoText,
} from "@/lib/gateway/upstreams/devin-wire";
import { GateError } from "@/lib/gateway/errors";
import { routePool } from "@/lib/gateway/routing/route-pool";
import type { JsonMap } from "@/types/gateway";
import type { ProtoField } from "@/types/devin";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

const logins = new Map<string, JsonMap>();

(globalThis as { prisma?: unknown }).prisma = {
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
  },
};

const realFetch = globalThis.fetch;
let calls: { url: string; body: Uint8Array; headers: Record<string, string> }[] = [];

function respondWith(handler: (url: string, body: Uint8Array) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = raw instanceof Uint8Array ? raw : new TextEncoder().encode(typeof raw === "string" ? raw : "");
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, body);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const dep: ResolvedDeployment = {
  id: "dep-devin",
  kind: "devin",
  model: "claude-opus-5-5",
  base_url: "",
  provider_id: "prov-devin",
  weight: 1,
  priority: 0,
  rpm: 0,
  tpm: 0,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0,
  enabled: true,
  provider: { id: "prov-devin", kind: "devin", apiKey: "", baseUrl: "" },
} as unknown as ResolvedDeployment;

function fieldsOf(data: Uint8Array, number: number): ProtoField[] {
  return protoFields(data).filter((field) => field.field === number);
}

function textOf(data: Uint8Array, number: number): string {
  const field = fieldsOf(data, number)[0];
  return field ? protoText(field) : "";
}

function numberOf(data: Uint8Array, number: number): number {
  const field = fieldsOf(data, number)[0];
  return field ? protoNumber(field) : -1;
}

function frame(writer: ProtoWriter): Uint8Array<ArrayBuffer> {
  return connectEnvelope(writer.finish());
}

function trailer(json: unknown = {}): Uint8Array<ArrayBuffer> {
  return connectEnvelope(new TextEncoder().encode(JSON.stringify(json)), CONNECT_FLAG_END_STREAM);
}

function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.concat(parts));
}

function usage(prompt: number, completion: number, cacheWrite: number, cacheRead: number, model = ""): ProtoWriter {
  const out = new ProtoWriter().varint(2, prompt).varint(3, completion).varint(4, cacheWrite).varint(5, cacheRead);
  return model ? out.string(9, model) : out;
}

function chunks(lines: string[]): JsonMap[] {
  return lines.map((line) => JSON.parse(line) as JsonMap);
}

function delta(chunk: JsonMap): JsonMap {
  return ((chunk.choices as JsonMap[])[0]!.delta ?? {}) as JsonMap;
}

function statusPayload(): Uint8Array {
  const org = new ProtoWriter().string(4, "org-1").string(8, "Acme");
  const planInfo = new ProtoWriter().string(2, "Pro").message(33, org);
  const planStatus = new ProtoWriter()
    .message(1, planInfo)
    .message(2, new ProtoWriter().varint(1, 1_789_087_364))
    .message(3, new ProtoWriter().varint(1, 1_791_679_364))
    .varint(14, 75)
    .varint(15, 0)
    .varint(17, 1_789_200_000)
    .varint(18, 1_789_286_400);
  const user = new ProtoWriter()
    .string(3, "devin-user")
    .string(5, "team-1")
    .string(7, "dev@example.com")
    .message(13, planStatus)
    .string(36, "user-42");
  return new ProtoWriter().message(1, user).finish();
}

test("protobuf fields encode to the wire bytes and decode back", () => {
  assert.deepEqual([...new ProtoWriter().varint(1, 150).finish()], [0x08, 0x96, 0x01]);
  assert.deepEqual([...new ProtoWriter().string(2, "hi").finish()], [0x12, 0x02, 0x68, 0x69]);
  assert.deepEqual([...new ProtoWriter().double(5, 1).finish()], [0x29, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  const nested = new ProtoWriter().string(1, "inner").varint(2, 2 ** 40);
  const data = new ProtoWriter().message(3, nested).double(4, 0.25).varint(5, 0).finish();
  const [message, double, zero] = protoFields(data);
  assert.equal(message!.field, 3);
  assert.equal(textOf(message!.bytes, 1), "inner");
  assert.equal(numberOf(message!.bytes, 2), 2 ** 40);
  assert.equal(protoDouble(double!), 0.25);
  assert.equal(protoNumber(zero!), 0);
  assert.throws(() => protoFields(Uint8Array.from([0x12, 0x05, 0x61])), /PROTO_TRUNCATED/);
});

test("Connect frames reassemble across chunks, inflate gzip, and reject unknown flags", () => {
  const first = new ProtoWriter().string(3, "Hello").finish();
  const second = new ProtoWriter().string(3, " world").finish();
  const compressed = gzipSync(second);
  const stream = joined(connectEnvelope(first), connectEnvelope(new Uint8Array(compressed), CONNECT_FLAG_COMPRESSED), trailer());
  const reader = new ConnectFrameReader();
  const frames = [...reader.push(stream.subarray(0, 3)), ...reader.push(stream.subarray(3, 11)), ...reader.push(stream.subarray(11))];
  assert.equal(frames.length, 3);
  assert.equal(textOf(frames[0]!.payload, 3), "Hello");
  assert.equal(textOf(frames[1]!.payload, 3), " world");
  assert.equal(frames[2]!.flag, CONNECT_FLAG_END_STREAM);
  assert.equal(reader.pending, false);
  assert.equal(connectFrames(stream.subarray(0, stream.length - 1)).complete, false);
  assert.throws(() => new ConnectFrameReader().push(Uint8Array.from([0x09, 0, 0, 0, 0])), /CONNECT_FRAME_INVALID/);
});

test("session tokens get the Devin prefix and pasted tokens are recognized", () => {
  assert.equal(formatSessionToken("eyJ.abc"), "devin-session-token$eyJ.abc");
  assert.equal(formatSessionToken("devin-session-token$eyJ.abc"), "devin-session-token$eyJ.abc");
  assert.equal(pastedSessionToken('"eyJ.abc"'), "devin-session-token$eyJ.abc");
  assert.equal(pastedSessionToken("ABCDEF"), "");
  const headers = devinHeaders("tok");
  assert.equal(headers.Authorization, "Basic tok-tok");
  assert.equal(headers["Content-Type"], "application/connect+proto");
  assert.equal(headers["Connect-Protocol-Version"], "1");
  assert.match(headers["Sentry-Trace"] ?? "", /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
});

test("model ids resolve to Devin chat model uids with clamped efforts", () => {
  assert.equal(devinModelUid("", ""), "swe-2-high");
  assert.equal(devinModelUid("swe-2", ""), "swe-2-high");
  assert.equal(devinModelUid("swe-2", "xhigh"), "swe-2-max");
  assert.equal(devinModelUid("swe-2", "low"), "swe-2-medium");
  assert.equal(devinModelUid("devin/claude-opus-5-5", "xhigh"), "claude-opus-5-5-xhigh");
  assert.equal(devinModelUid("claude-opus-5.5", ""), "claude-opus-5-5-medium");
  assert.equal(devinModelUid("gpt-5-6-luna", ""), "gpt-5-6-luna-low");
  assert.equal(devinModelUid("gpt-6-sol", "none"), "gpt-6-sol-none");
  assert.equal(devinModelUid("glm-5-3", "medium"), "glm-5-3-high");
  assert.equal(devinModelUid("gemini-3-8-flash", ""), "gemini-3-8-flash-high");
  assert.equal(devinModelUid("claude-opus-4-6", "high"), "claude-opus-4-6-thinking");
  assert.equal(devinModelUid("claude-opus-4-6", ""), "claude-opus-4-6");
  assert.equal(devinModelUid("claude-sonnet-4-6-1m", "low"), "claude-sonnet-4-6-thinking-1m");
  assert.equal(devinModelUid("claude-sonnet-4-5", "high"), "MODEL_PRIVATE_3");
  assert.equal(devinModelUid("claude-sonnet-4-5", ""), "MODEL_PRIVATE_2");
  assert.equal(devinModelUid("claude-haiku-4-5", "high"), "MODEL_PRIVATE_11");
  assert.equal(devinModelUid("MODEL_GPT_5_2", "medium"), "MODEL_GPT_5_2_MEDIUM");
  assert.equal(devinModelUid("MODEL_CLAUDE_4_5_OPUS", "high"), "MODEL_CLAUDE_4_5_OPUS_THINKING");
  assert.equal(devinModelUid("swe-2-max", "low"), "swe-2-max");
  assert.equal(devinModelUid("kimi-k2-6", "high"), "kimi-k2-6");
  assert.equal(normalizeDevinEffort("", 20_000), "high");
  assert.equal(normalizeDevinEffort("adaptive"), "high");
  assert.equal(normalizeDevinEffort("off"), "none");
});

test("discovered variants decide the levels and the fast or priority tier", () => {
  const variants = ["inkling-low", "inkling-high", "inkling-high-fast", "inkling-low-priority"];
  assert.equal(devinModelUid("inkling", "medium", variants), "inkling-high");
  assert.equal(devinModelUid("inkling", "high", variants, "fast"), "inkling-high-fast");
  assert.equal(devinModelUid("inkling", "low", variants, "fast"), "inkling-low");
  assert.equal(devinModelUid("inkling", "low", variants, "priority"), "inkling-low-priority");
  assert.equal(devinModelUid("swe-1-6", "", ["swe-1-6", "swe-1-6-fast"], "fast"), "swe-1-6-fast");
  assert.deepEqual(splitDevinUid("claude-opus-5-low-fast"), { base: "claude-opus-5", effort: "low", tier: "fast" });
  assert.deepEqual(splitDevinUid("claude-opus-4-6-thinking-1m"), { base: "claude-opus-4-6-1m", effort: "", tier: "" });
  assert.deepEqual(splitDevinUid("MODEL_GPT_5_2_HIGH"), { base: "MODEL_GPT_5_2", effort: "high", tier: "" });
});

test("the model catalog groups variants under one base model with vendor and context", () => {
  const config = (uid: string, label: string, vendor: number, context: number, multimodal = true) =>
    new ProtoWriter().string(1, label).varint(5, multimodal ? 1 : 0).varint(10, vendor).varint(18, context).string(22, uid);
  const data = new ProtoWriter()
    .message(1, config("swe-2-high", "SWE-2 High", 1, 262_000))
    .message(1, config("swe-2-max", "SWE-2 Max", 1, 262_000))
    .message(1, config("gpt-6-astra-low", "GPT-6 Astra Low Thinking", 2, 1_000_000))
    .message(1, config("grok-4-7-low", "Grok 4.7 Low", 0, 500_000))
    .message(1, new ProtoWriter().string(1, "no uid"))
    .finish();
  const parsed = parseDevinModelConfigs(data);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], { uid: "swe-2-high", label: "SWE-2 High", multimodal: true, vendor: 1, contextLength: 262_000 });
  const models = devinModels(parsed);
  assert.deepEqual(
    models.map((model) => [model.id, model.name, model.ownedBy, model.contextLength, model.variants]),
    [
      ["gpt-6-astra", "GPT-6 Astra", "openai", 1_000_000, ["gpt-6-astra-low"]],
      ["grok-4-7", "Grok 4.7", "xai", 500_000, ["grok-4-7-low"]],
      ["swe-2", "SWE-2", "cognition", 262_000, ["swe-2-high", "swe-2-max"]],
    ],
  );
  assert.equal(cleanDevinDisplayName("Claude Opus 5 Max Thinking Fast"), "Claude Opus 5");
});

test("chat messages become Devin prompts with tools, images, and tool results", () => {
  const image = "data:image/jpeg;base64,QUJD";
  const payload = chatToDevin(
    {
      model: "claude-opus-5-5",
      reasoning_effort: "high",
      max_tokens: 1000,
      temperature: 0.3,
      prompt_cache_key: "session-a",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "Use tools." }] },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: image } }] },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call 1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
        },
        { role: "tool", tool_call_id: "call 1", content: "file body" },
        { role: "tool", tool_call_id: "unknown", content: "" },
      ],
      tools: [
        { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
        { type: "web_search" },
      ],
    },
    undefined,
  );
  assert.equal(payload.model, "claude-opus-5-5-high");
  assert.equal(payload.system, "Be brief.\n\nUse tools.");
  assert.equal(payload.maxTokens, 1000);
  assert.equal(payload.temperature, 0.3);
  assert.match(String(payload.session), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(chatToDevin({ prompt_cache_key: "session-a", messages: [] }).session, payload.session);
  const prompts = payload.prompts as JsonMap[];
  assert.deepEqual(
    prompts.map((item) => [item.source, item.content, item.toolCallId]),
    [
      [1, "[Image 1: pasted_image_1.jpg]\n\nLook", ""],
      [2, "", ""],
      [4, "file body", "call 1"],
      [1, "{}", ""],
    ],
  );
  assert.deepEqual(prompts[0]!.images, [{ mimeType: "image/jpeg", data: "QUJD" }]);
  assert.deepEqual(prompts[1]!.toolCalls, [{ id: "call 1", name: "read", arguments: '{"path":"a"}' }]);
  assert.deepEqual(payload.tools, [{ name: "read", description: "Read a file", parameters: '{"type":"object"}' }]);
  assert.equal(chatToDevin({ model: "swe-2", max_tokens: 500_000, messages: [] }).maxTokens, 64_000);
});

test("remote images and unsupported content parts are refused", () => {
  const remote = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] };
  assert.throws(() => chatToDevin(remote), (err: unknown) => err instanceof GateError && err.status === 400);
  const audio = { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] };
  assert.throws(() => chatToDevin(audio), /input_audio/);
});

test("tool call ids that Devin may reject round trip through a portable encoding", () => {
  assert.equal(encodeToolCallId("toolu_01ABC"), "toolu_01ABC");
  const encoded = encodeToolCallId("call:1/2");
  assert.match(encoded, /^devin_call_[A-Za-z0-9_-]+$/);
  assert.equal(decodeToolCallId(encoded), "call:1/2");
  assert.equal(decodeToolCallId("devin_call_!!"), "devin_call_!!");
  const prefixed = encodeToolCallId("devin_call_x");
  assert.notEqual(prefixed, "devin_call_x");
  assert.equal(decodeToolCallId(prefixed), "devin_call_x");
});

test("the request encodes metadata, prompts, completion config, tools, and the session thread", () => {
  const payload = chatToDevin({
    model: "swe-2",
    prompt_cache_key: `encode-${Date.now()}`,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
  });
  const envelope = encodeDevinRequest(payload, "tok");
  const { frames, complete } = connectFrames(envelope);
  assert.equal(complete, true);
  assert.equal(frames.length, 1);
  const body = frames[0]!.payload;
  const metadata = fieldsOf(body, 1)[0]!.bytes;
  assert.equal(textOf(metadata, 1), "chisel");
  assert.equal(textOf(metadata, 2), "3000.10.21");
  assert.equal(textOf(metadata, 3), "tok");
  assert.match(textOf(metadata, 31), /^[0-9a-f]{732}$/);
  assert.equal(textOf(body, 2), "sys");
  const [prompt] = fieldsOf(body, 3);
  assert.equal(numberOf(prompt!.bytes, 2), 1);
  assert.equal(textOf(prompt!.bytes, 3), "hi");
  assert.equal(numberOf(body, 7), 5);
  const config = fieldsOf(body, 8)[0]!.bytes;
  assert.equal(numberOf(config, 2), 64_000);
  assert.equal(numberOf(config, 3), 400);
  assert.equal(protoDouble(fieldsOf(config, 5)[0]!), 1);
  assert.equal(numberOf(config, 7), 40);
  assert.equal(protoDouble(fieldsOf(config, 8)[0]!), Math.fround(0.95));
  const tool = fieldsOf(body, 10)[0]!.bytes;
  assert.equal(textOf(tool, 1), "run");
  assert.equal(textOf(tool, 3), '{"type":"object"}');
  const thread = fieldsOf(body, 15)[0]!.bytes;
  assert.equal(textOf(thread, 1), payload.session);
  assert.equal(fieldsOf(thread, 2).length, 0);
  assert.equal(numberOf(thread, 3), 4);
  assert.equal(numberOf(thread, 4), 14);
  assert.equal(textOf(body, 16), payload.session);
  assert.equal(numberOf(body, 20), 1);
  assert.equal(textOf(body, 21), "swe-2-high");
  const second = fieldsOf(connectFrames(encodeDevinRequest(payload, "tok")).frames[0]!.payload, 15)[0]!.bytes;
  assert.equal(numberOf(second, 2), 1);
});

test("Devin thinking signatures never reach Anthropic as Claude signatures", async () => {
  const { chatToAnthropic } = await import("@/lib/gateway/protocols/anthropic");
  const signature = devinSignature("anthropic", Uint8Array.from([9]));
  const native = chatToAnthropic({
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", thinking_blocks: [{ type: "thinking", thinking: "t", signature }] },
      { role: "user", content: "next" },
    ],
  });
  assert.equal(JSON.stringify(native).includes(signature), false);
});

test("assistant turns send back Devin thinking signatures and ignore foreign ones", () => {
  const signature = devinSignature("anthropic", Uint8Array.from([1, 2, 3]));
  assert.deepEqual(parseDevinSignature(signature), { type: "anthropic", bytes: Uint8Array.from([1, 2, 3]) });
  assert.equal(parseDevinSignature("EqQBCkgIBhABGAIiQ"), null);
  const payload = chatToDevin({
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "a",
        thinking_blocks: [
          { type: "thinking", thinking: "foreign", signature: "EqQBCkgI" },
          { type: "thinking", thinking: "mine", signature },
        ],
      },
      { role: "user", content: "next" },
    ],
  });
  const assistant = (payload.prompts as JsonMap[])[1]!;
  assert.equal(assistant.thinking, "mine");
  assert.equal(assistant.signatureType, "anthropic");
  const body = connectFrames(encodeDevinRequest(payload, "tok")).frames[0]!.payload;
  const encoded = fieldsOf(body, 3)[1]!.bytes;
  assert.equal(textOf(encoded, 11), "mine");
  assert.deepEqual([...fieldsOf(encoded, 12)[0]!.bytes], [1, 2, 3]);
  assert.equal(textOf(encoded, 18), "anthropic");
});

test("response frames stream as chat chunks with reasoning, text, a signed thinking block, and usage", () => {
  const translator = new DevinChatTranslator("alias");
  const smile = new TextEncoder().encode("é");
  const out = [
    ...translator.push({ flag: 0, payload: new ProtoWriter().string(9, "thinking").finish() }),
    ...translator.push({ flag: 0, payload: new ProtoWriter().bytes(10, Uint8Array.from([7, 8])).string(21, "anthropic").finish() }),
    ...translator.push({ flag: 0, payload: new ProtoWriter().string(3, "Caf").bytes(3, smile.subarray(0, 1)).finish() }),
    ...translator.push({ flag: 0, payload: new ProtoWriter().bytes(3, smile.subarray(1)).finish() }),
    ...translator.push({ flag: 0, payload: new ProtoWriter().message(7, usage(10, 4, 100, 50, "claude-opus-5-5-high")).varint(5, 2).finish() }),
    ...translator.push({ flag: CONNECT_FLAG_END_STREAM, payload: new TextEncoder().encode("{}") }),
  ];
  const parsed = chunks(out);
  assert.equal(delta(parsed[0]!).role, "assistant");
  assert.equal(delta(parsed[0]!).reasoning_content, "thinking");
  assert.equal(parsed.map((chunk) => String(delta(chunk).content ?? "")).join(""), "Café");
  const blocks = parsed.flatMap((chunk) => (delta(chunk).thinking_blocks as JsonMap[] | undefined) ?? []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.thinking, "thinking");
  assert.deepEqual(parseDevinSignature(blocks[0]!.signature), { type: "anthropic", bytes: Uint8Array.from([7, 8]) });
  const last = parsed.at(-1)!;
  assert.equal((last.choices as JsonMap[])[0]!.finish_reason, "stop");
  assert.deepEqual(last.usage, {
    prompt_tokens: 160,
    completion_tokens: 4,
    total_tokens: 164,
    prompt_tokens_details: { cached_tokens: 50 },
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 100,
  });
  assert.equal(translator.done, true);
  assert.deepEqual(translator.push({ flag: 0, payload: new ProtoWriter().string(3, "late").finish() }), []);
});

test("tool call deltas stream under one index and finish as tool_calls", () => {
  const translator = new DevinChatTranslator("alias");
  const call = (fields: ProtoWriter) => ({ flag: 0, payload: new ProtoWriter().message(6, fields).finish() });
  const out = chunks([
    ...translator.push(call(new ProtoWriter().string(1, "call:1").string(2, "read").string(3, '{"pa'))),
    ...translator.push(call(new ProtoWriter().string(3, 'th":"a"}'))),
    ...translator.push(call(new ProtoWriter().string(1, "c2").string(2, "list"))),
    ...translator.push({ flag: CONNECT_FLAG_END_STREAM, payload: new Uint8Array() }),
  ]);
  const toolDeltas = out.flatMap((chunk) => (delta(chunk).tool_calls as JsonMap[] | undefined) ?? []);
  assert.equal(toolDeltas[0]!.index, 0);
  assert.equal(toolDeltas[0]!.id, encodeToolCallId("call:1"));
  assert.equal((toolDeltas[0]!.function as JsonMap).name, "read");
  assert.equal((toolDeltas[1]!.function as JsonMap).arguments, 'th":"a"}');
  assert.equal(toolDeltas[2]!.index, 1);
  assert.equal(toolDeltas[2]!.id, "c2");
  assert.equal((out.at(-1)!.choices as JsonMap[])[0]!.finish_reason, "tool_calls");
});

test("a whole reply aggregates into one chat completion and a cut stream fails", () => {
  const raw = joined(
    frame(new ProtoWriter().string(3, "Pong")),
    frame(new ProtoWriter().message(7, usage(3, 1, 0, 0)).varint(5, 3)),
    trailer(),
  );
  const json = devinCompletion(raw, "alias");
  const choice = (json.choices as JsonMap[])[0]!;
  assert.equal((choice.message as JsonMap).content, "Pong");
  assert.equal(choice.finish_reason, "length");
  assert.equal((json.usage as JsonMap).prompt_tokens, 3);
  assert.throws(
    () => devinCompletion(frame(new ProtoWriter().string(3, "Po")), "alias"),
    (err: unknown) => err instanceof GateError && err.status === 502,
  );
});

test("token usage falls back to the response dimension groups", () => {
  const metric = (key: string, value: number) => {
    const reading = new Uint8Array(9);
    reading[0] = (2 << 3) | 5;
    new DataView(reading.buffer).setFloat32(1, value, true);
    return new ProtoWriter().bytes(4, reading.subarray(0, 5)).string(5, key);
  };
  const group = new ProtoWriter()
    .string(1, "Token Usage")
    .message(2, metric("input_tokens", 12))
    .message(2, metric("output_tokens", 5))
    .message(2, metric("cached_input_tokens", 3))
    .finish();
  assert.deepEqual(dimensionUsage([group]), { prompt: 12, completion: 5, cacheRead: 3 });
  const json = devinCompletion(joined(frame(new ProtoWriter().string(3, "x").bytes(28, group)), trailer()), "alias");
  assert.equal((json.usage as JsonMap).prompt_tokens, 15);
  assert.equal((json.usage as JsonMap).completion_tokens, 5);
});

test("trailer errors map to HTTP statuses and quota exhaustion waits for the window reset", () => {
  assert.equal(parseDevinTrailer(new TextEncoder().encode("{}")), null);
  const cases: [string, string, number][] = [
    ["unauthenticated", "bad token", 401],
    ["permission_denied", "model under high demand", 429],
    ["permission_denied", "not allowed", 403],
    ["resource_exhausted", "slow down", 429],
    ["failed_precondition", "out of credits", 429],
    ["failed_precondition", "bad request", 400],
    ["invalid_argument", "internal error", 502],
    ["unavailable", "down", 503],
  ];
  for (const [code, message, status] of cases) {
    const parsed = parseDevinTrailer(new TextEncoder().encode(JSON.stringify({ error: { code, message } })));
    assert.equal(parsed?.status, status, `${code}: ${message}`);
  }
  assert.equal(devinQuotaWindow("Your daily usage quota has been exhausted"), 86_400);
  assert.equal(devinQuotaWindow("weekly and daily quota exhausted"), 604_800);
  assert.equal(devinQuotaWindow("monthly ACU quota exhausted"), null);
  const reset = Date.now() + 3_600_000;
  const translator = new DevinChatTranslator("alias", (window) => (window === 86_400 ? reset : null));
  assert.throws(
    () =>
      translator.push({
        flag: CONNECT_FLAG_END_STREAM,
        payload: new TextEncoder().encode(JSON.stringify({ error: { code: "resource_exhausted", message: "daily quota exhausted" } })),
      }),
    (err: unknown) => err instanceof GateError && err.status === 429 && err.retryAt === reset && err.code === "resource_exhausted",
  );
  const http = devinHttpError(401, JSON.stringify({ code: "unauthenticated", message: "expired session" }));
  assert.equal(http.status, 401);
  assert.equal(http.message, "expired session");
  assert.equal(http.code, "upstream_error");
});

test("the event stream relays chat chunks, ends with DONE, and fails before the first byte on errors", async () => {
  const body = joined(frame(new ProtoWriter().string(3, "Hi")), frame(new ProtoWriter().message(7, usage(2, 1, 0, 0))), trailer());
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 4));
        controller.enqueue(body.subarray(4));
        controller.close();
      },
    }),
  );
  const res = await devinEventStream(upstream, "alias");
  const text = await res.text();
  const lines = text.split("\n\n").filter(Boolean);
  assert.equal(lines.at(-1), "data: [DONE]");
  const payloads = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)) as JsonMap);
  assert.equal(delta(payloads[0]!).content, "Hi");
  assert.equal((payloads.at(-1)!.usage as JsonMap).total_tokens, 3);
  const failing = new Response(trailer({ error: { code: "unauthenticated", message: "no" } }));
  await assert.rejects(devinEventStream(failing, "alias"), (err: unknown) => err instanceof GateError && err.status === 401);
});

test("user status parses plan, organization, and daily and weekly quota into limit windows", () => {
  const status = parseDevinStatus(statusPayload());
  assert.deepEqual(status, {
    email: "dev@example.com",
    userName: "devin-user",
    userId: "user-42",
    teamId: "team-1",
    orgId: "org-1",
    orgName: "Acme",
    plan: "Pro",
    dailyRemaining: 75,
    weeklyRemaining: 0,
    dailyResetAt: 1_789_200_000_000,
    weeklyResetAt: 1_789_286_400_000,
    planStart: 1_789_087_364_000,
    planEnd: 1_791_679_364_000,
  });
  const limits = devinLimits(status, 1_789_100_000_000);
  assert.equal(limits.plan, "Pro");
  assert.deepEqual(limits.windows, [
    { scope: "", usedPercent: 25, windowSeconds: 86_400, resetsAt: new Date(1_789_200_000_000).toISOString(), limitReached: false },
    { scope: "", usedPercent: 100, windowSeconds: 604_800, resetsAt: new Date(1_789_286_400_000).toISOString(), limitReached: true },
  ]);
  assert.equal(windowReset(limits, 86_400, 1_789_100_000_000), 1_789_200_000_000);
  assert.equal(windowReset(limits, 86_400, 1_789_300_000_000), null);
  assert.throws(() => parseDevinStatus(new Uint8Array()), /DEVIN_STATUS_EMPTY/);
  assert.equal(devinLimits(parseDevinStatus(new ProtoWriter().message(1, new ProtoWriter()).finish())).windows.length, 0);
});

test("Devin sessions keep the permanent token and name the account by email", () => {
  const status = parseDevinStatus(statusPayload());
  const session = devinSession("tok", { status, profile: { userName: "profile-user", userId: "profile-id", orgId: "" } });
  assert.deepEqual(session, {
    tokens: { access: "tok", refresh: "tok", accountId: "profile-id", residency: "" },
    expiresAt: DEVIN_SESSION_EXPIRES_AT,
    account: "dev@example.com",
    plan: "Pro",
  });
  const fallback = devinSession("tok", { profile: { userName: "profile-user", userId: "", orgId: "" } });
  assert.equal(fallback.account, "profile-user");
  assert.equal(devinSession("tok", {}, session).account, "dev@example.com");
});

test("devin deployments belong to the subscription pool and post Connect frames to GetChatMessage", async () => {
  const { joinPath, prepareBody, proxyJson, upstreamHeaders } = await import("@/lib/gateway/dispatch/upstream");
  const { signInHeaders } = await import("@/lib/gateway/upstreams/credentials");
  assert.equal(routePool({ kind: "devin" }), "subscription");
  const url = "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage";
  assert.equal(joinPath(dep, "/chat/completions"), url);
  assert.throws(() => joinPath(dep, "/embeddings"), (err: unknown) => err instanceof GateError && err.status === 400);
  const auth = { key: "tok", headers: signInHeaders("devin", { access: "tok", refresh: "tok", accountId: "", residency: "" }) };
  const headers = upstreamHeaders(dep, auth);
  assert.equal(headers.Authorization, "Basic tok-tok");
  assert.equal(headers["Content-Type"], "application/connect+proto");
  const prepared = prepareBody(dep, "/chat/completions", { model: "alias", reasoning_effort: "max", messages: [{ role: "user", content: "x" }] });
  assert.equal(prepared.model, "claude-opus-5-5-max");
  respondWith(() =>
    new Response(joined(frame(new ProtoWriter().string(3, "Pong")), frame(new ProtoWriter().message(7, usage(3, 1, 0, 0))), trailer()), {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
    }),
  );
  const result = await proxyJson({ dep, auth, path: "/chat/completions", body: { model: "alias", messages: [{ role: "user", content: "Ping" }] } });
  assert.equal(result.status, 200);
  assert.equal(calls[0]!.url, url);
  const sent = connectFrames(calls[0]!.body).frames[0]!.payload;
  assert.equal(textOf(fieldsOf(sent, 3)[0]!.bytes, 3), "Ping");
  assert.equal(textOf(sent, 21), "claude-opus-5-5-medium");
  const json = result.json as JsonMap;
  assert.equal(((json.choices as JsonMap[])[0]!.message as JsonMap).content, "Pong");
});

test("fast mode picks a listed fast variant and is offered only when the account lists one", async () => {
  const { applyProviderServiceMode, modeSupport } = await import("@/lib/gateway/dispatch/service-mode");
  assert.equal(applyProviderServiceMode("devin", { service_tier: "priority", speed: "fast" }).body.service_tier, "priority");
  assert.equal(applyProviderServiceMode("devin", { speed: "fast" }).body.service_tier, "fast");
  assert.equal(applyProviderServiceMode("devin", { service_tier: "flex" }).body.service_tier, undefined);
  assert.equal(modeSupport({ kind: "devin", model: "inkling", facts: { variants: ["inkling-high-fast"] } }, "fast"), "confirmed");
  assert.equal(modeSupport({ kind: "devin", model: "inkling", facts: { variants: ["inkling-high"] } }, "fast"), "none");
  assert.equal(modeSupport({ kind: "devin", model: "inkling" }, "ultrafast"), "none");
});

test("a streamed chat goes out as Connect frames with the account token and comes back as OpenAI SSE", async () => {
  const { openChatStream } = await import("@/lib/gateway/dispatch/chat");
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  const { DEVIN_SESSION_EXPIRES_AT } = await import("@/lib/gateway/upstreams/devin-account");
  logins.set("prov-devin", {
    providerId: "prov-devin",
    account: "dev@example.com",
    plan: "Pro",
    tokens: sealTokens({ access: "stream-token", refresh: "stream-token", accountId: "user-42", residency: "" }),
    expiresAt: new Date(DEVIN_SESSION_EXPIRES_AT),
    status: "active",
    version: 0,
    refreshedAt: null,
    retryAt: null,
    failures: 0,
  });
  respondWith(() => new Response(joined(frame(new ProtoWriter().string(9, "hmm").string(3, "Hello")), trailer()), { status: 200 }));
  const group = { alias: "alias", strategy: "", mapped: [], fallback_groups: [], num_retries: 0 } as unknown as ResolvedModelGroup;
  const res = await openChatStream(dep, group, {
    req: new Request("http://hub.test/api/subscription/v1/chat/completions"),
    model: "alias",
    body: { model: "alias", messages: [{ role: "user", content: "hi" }] },
  });
  const sent = calls[0]!;
  assert.equal(sent.url, "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage");
  assert.equal(sent.headers.Authorization, "Basic stream-token-stream-token");
  assert.equal(sent.headers.Accept, "*/*");
  assert.equal(sent.headers["Content-Type"], "application/connect+proto");
  assert.equal(textOf(fieldsOf(connectFrames(sent.body).frames[0]!.payload, 1)[0]!.bytes, 3), "stream-token");
  const text = await res.text();
  assert.match(text, /"reasoning_content":"hmm"/);
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});
