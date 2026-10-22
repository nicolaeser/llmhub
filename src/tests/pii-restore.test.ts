import assert from "node:assert/strict";
import test from "node:test";
import { redactJSON, redactPii } from "@/lib/gateway/safety/pii";
import { PiiVault, bindPiiVault, piiRestoreSummary, restoreJson, vaultOf } from "@/lib/gateway/safety/pii-vault";
import { restoreChatSse } from "@/lib/gateway/safety/restore-chat";
import { restoreClientJson } from "@/lib/gateway/safety/restore-client";
import { restoreMessagesSse } from "@/lib/gateway/safety/restore-messages";
import { restoreResponsesSse } from "@/lib/gateway/safety/restore-responses";
import type { JsonMap } from "@/types/gateway";

const EMAIL = "ada@acme.com";
const TOKEN = "[EMAIL_ADDRESS_1]";
const TRICKY = 'Zoë "Q" \\ ☃';
const CONTROL = 'Zoë "Q" \\ ☃\t\n\u0001';

function emailVault(): PiiVault {
  const vault = new PiiVault();
  assert.equal(vault.placeholder("EMAIL_ADDRESS", EMAIL), TOKEN);
  return vault;
}

function sseFrames(frames: string[]): Response {
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

function chatChunk(choices: JsonMap[], extra: JsonMap = {}): string {
  return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", ...extra, choices })}\n\n`;
}

function contentChunk(content: string, index = 0): string {
  return chatChunk([{ index, delta: { content }, finish_reason: null }]);
}

function finishChunk(index = 0, reason = "stop"): string {
  return chatChunk([{ index, delta: {}, finish_reason: reason }]);
}

function argumentsChunk(piece: string): string {
  return chatChunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }]);
}

function responsesFrames(events: JsonMap[], first = 0): string[] {
  return events.map(
    (event, offset) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: first + offset })}\n\n`,
  );
}

function textDelta(delta: string): JsonMap {
  return { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta, logprobs: [] };
}

function argumentsDelta(delta: string): JsonMap {
  return { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta };
}

function summaryDelta(delta: string): JsonMap {
  return { type: "response.reasoning_summary_text.delta", item_id: "rs_2", output_index: 1, summary_index: 0, delta };
}

function blocks(text: string): string[] {
  return text.split("\n\n").filter((block) => block.trim());
}

function parsedEvents(text: string): JsonMap[] {
  return blocks(text)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n"),
    )
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as JsonMap);
}

function chatChoices(events: JsonMap[], index: number): JsonMap[] {
  return events
    .flatMap((event) => (Array.isArray(event.choices) ? (event.choices as JsonMap[]) : []))
    .filter((choice) => choice.index === index);
}

function joined(values: unknown[]): string {
  return values.filter((value): value is string => typeof value === "string").join("");
}

const deltaOf = (choice: JsonMap): JsonMap => (choice.delta as JsonMap | undefined) ?? {};
const contentOf = (choice: JsonMap): unknown => deltaOf(choice).content;
const argumentsOf = (choice: JsonMap): unknown =>
  ((((deltaOf(choice).tool_calls as JsonMap[] | undefined) ?? [])[0]?.function as JsonMap | undefined) ?? {}).arguments;

function chatText(events: JsonMap[], index: number, read: (choice: JsonMap) => unknown): string {
  return joined(chatChoices(events, index).map(read));
}

function responsesText(events: JsonMap[], type: string): string {
  return joined(events.filter((event) => event.type === type).map((event) => event.delta));
}

test("restore numbers personal data and leaves secrets masked", () => {
  const vault = new PiiVault();
  const masked = redactPii("Write ada@acme.com and again ada@acme.com", ["EMAIL_ADDRESS"], undefined, vault);
  assert.equal(masked, "Write [EMAIL_ADDRESS_1] and again [EMAIL_ADDRESS_1]");
  const secret = redactPii("token sk-live-secret-value", ["SECRET"], undefined, vault);
  assert.match(secret, /\[SECRET\]/);
  assert.equal(secret.includes("SECRET_"), false);
  assert.equal(vault.restore(secret), secret);
  assert.equal(vault.restore(masked), "Write ada@acme.com and again ada@acme.com");
  const logged = { content: masked };
  const restored = restoreJson(structuredClone(logged), vault) as { content: string };
  assert.equal(logged.content, masked);
  assert.equal(restored.content, "Write ada@acme.com and again ada@acme.com");
});

test("block mode stays a static placeholder", () => {
  const masked = redactPii("ada@acme.com", ["EMAIL_ADDRESS"]);
  assert.equal(masked, "[EMAIL_ADDRESS]");
  assert.equal(new PiiVault().restore(masked), masked);
});

test("client restore uses the request vault and leaves the stored object masked", () => {
  const trace = {
    endpoint: "chat",
    piiMode: "restore" as const,
    piiInput: new Set<string>(),
    piiOutput: new Set<string>(),
    guardInput: new Set<string>(),
    guardOutput: new Set<string>(),
    guardBlocked: false,
  };
  const vault = new PiiVault();
  bindPiiVault(trace, vault);
  const stored = redactJSON({ messages: [{ content: "ada@acme.com" }] }, ["EMAIL_ADDRESS"], "", undefined, vault) as {
    messages: { content: string }[];
  };
  assert.equal(stored.messages[0]?.content, "[EMAIL_ADDRESS_1]");
  const visible = restoreClientJson(trace, stored) as { messages: { content: string }[] };
  assert.equal(stored.messages[0]?.content, "[EMAIL_ADDRESS_1]");
  assert.equal(visible.messages[0]?.content, "ada@acme.com");
  assert.equal(vaultOf(trace), vault);
});

test("non-stream restore escapes tool arguments and leaves signed reasoning untouched", () => {
  const vault = new PiiVault();
  vault.placeholder("PERSON", TRICKY);
  const message = {
    content: "Hi [PERSON_1]",
    reasoning_content: "About [PERSON_1]",
    tool_calls: [{ id: "t1", type: "function", function: { name: "send", arguments: '{"to":"[PERSON_1]"}' } }],
    thinking_blocks: [
      { type: "thinking", thinking: "About [PERSON_1]", signature: "sig-[PERSON_1]" },
      { type: "redacted_thinking", data: "opaque-[PERSON_1]" },
    ],
    reasoning_details: [{ type: "reasoning.text", text: "About [PERSON_1]", signature: "sig" }],
  };
  const restored = restoreJson(structuredClone(message), vault) as typeof message;
  assert.equal(restored.content, `Hi ${TRICKY}`);
  assert.equal(restored.reasoning_content, `About ${TRICKY}`);
  assert.deepEqual(JSON.parse(restored.tool_calls[0]!.function.arguments), { to: TRICKY });
  assert.deepEqual(restored.thinking_blocks, message.thinking_blocks);
  assert.deepEqual(restored.reasoning_details, message.reasoning_details);
  const item = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "About [PERSON_1]" }],
    encrypted_content: "enc-[PERSON_1]",
  };
  assert.deepEqual(restoreJson(item, vault), { ...item, summary: [{ type: "summary_text", text: `About ${TRICKY}` }] });
});

test("chat streams restore placeholders split across two and three events in content and tool arguments", async () => {
  const text = await restoreChatSse(
    sseFrames([
      chatChunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
      contentChunk("Mail [EMAIL_"),
      contentChunk("ADDRESS_1] or [EM"),
      contentChunk("AIL_ADD"),
      contentChunk("RESS_1]."),
      chatChunk([
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "send", arguments: "" } }] },
          finish_reason: null,
        },
      ]),
      argumentsChunk('{"to": "[EM'),
      argumentsChunk("AIL_ADD"),
      argumentsChunk('RESS_1]"}'),
      finishChunk(0, "tool_calls"),
      "data: [DONE]\n\n",
    ]),
    emailVault(),
  ).text();
  const events = parsedEvents(text);
  const pieces = chatChoices(events, 0)
    .map(contentOf)
    .filter((piece) => typeof piece === "string" && piece);
  assert.deepEqual(pieces, ["Mail ", `${EMAIL} or `, `${EMAIL}.`]);
  assert.deepEqual(JSON.parse(chatText(events, 0, argumentsOf)), { to: EMAIL });
  assert.equal(text.includes("EMAIL_ADDRESS"), false);
  assert.equal(blocks(text).at(-1), "data: [DONE]");
  assert.equal(deltaOf(chatChoices(events, 0)[0]!).role, "assistant");

  const legacyChunk = (piece: string, finish: string | null) =>
    `data: ${JSON.stringify({ id: "cmpl-1", object: "text_completion", choices: [{ text: piece, index: 0, logprobs: null, finish_reason: finish }] })}\n\n`;
  const legacy = await restoreChatSse(
    sseFrames([legacyChunk("to [EMAIL_ADD", null), legacyChunk("RESS_1]", "stop"), "data: [DONE]\n\n"]),
    emailVault(),
  ).text();
  assert.equal(chatText(parsedEvents(legacy), 0, (choice) => choice.text), `to ${EMAIL}`);
});

test("Responses streams restore placeholders split across two and three events in text and function arguments", async () => {
  const text = await restoreResponsesSse(
    sseFrames(
      responsesFrames([
        { type: "response.created", response: { id: "resp_1", output: [] } },
        textDelta("Mail [EMAIL_"),
        textDelta("ADDRESS_1] or [EM"),
        textDelta("AIL_ADD"),
        textDelta("RESS_1]."),
        { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: `Mail ${TOKEN} or ${TOKEN}.` },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: `Mail ${TOKEN} or ${TOKEN}.` }] },
        },
        argumentsDelta('{"to": "[EM'),
        argumentsDelta("AIL_ADD"),
        argumentsDelta('RESS_1]"}'),
        { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: `{"to": "${TOKEN}"}` },
        { type: "response.completed", response: { id: "resp_1", output_text: `Mail ${TOKEN} or ${TOKEN}.` } },
      ]),
    ),
    emailVault(),
  ).text();
  const events = parsedEvents(text);
  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta);
  assert.deepEqual(deltas, ["Mail ", `${EMAIL} or `, `${EMAIL}.`]);
  assert.equal(events.find((event) => event.type === "response.output_text.done")?.text, `Mail ${EMAIL} or ${EMAIL}.`);
  assert.deepEqual(JSON.parse(responsesText(events, "response.function_call_arguments.delta")), { to: EMAIL });
  assert.equal(text.includes("EMAIL_ADDRESS"), false);
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index),
  );
  assert.ok(blocks(text).every((block) => block.startsWith(`event: ${String(parsedEvents(block)[0]?.type)}\n`)));
});

test("restored values with quotes, backslashes, and unicode keep every event valid JSON", async () => {
  const vault = new PiiVault();
  vault.placeholder("PERSON", TRICKY);
  const chat = await restoreChatSse(
    sseFrames([
      contentChunk("Hi [PER"),
      contentChunk("SON_1]"),
      argumentsChunk('{"to":"[PERSON'),
      argumentsChunk('_1]"}'),
      finishChunk(),
      "data: [DONE]\n\n",
    ]),
    vault,
  ).text();
  const chatEvents = parsedEvents(chat);
  assert.equal(chatText(chatEvents, 0, contentOf), `Hi ${TRICKY}`);
  assert.deepEqual(JSON.parse(chatText(chatEvents, 0, argumentsOf)), { to: TRICKY });

  const responses = await restoreResponsesSse(
    sseFrames(
      responsesFrames([
        textDelta("Hi [PER"),
        textDelta("SON_1]"),
        argumentsDelta('{"to":"[PERSON'),
        argumentsDelta('_1]"}'),
        { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"to":"[PERSON_1]"}' },
      ]),
    ),
    vault,
  ).text();
  const responsesEvents = parsedEvents(responses);
  assert.equal(responsesText(responsesEvents, "response.output_text.delta"), `Hi ${TRICKY}`);
  assert.deepEqual(JSON.parse(responsesText(responsesEvents, "response.function_call_arguments.delta")), { to: TRICKY });
  const done = responsesEvents.find((event) => event.type === "response.function_call_arguments.done");
  assert.deepEqual(JSON.parse(String(done?.arguments)), { to: TRICKY });
});

test("signed reasoning and encrypted content pass through byte-identical", async () => {
  const signedChat = `data: {"id":"c1","choices":[{"index":0,"delta":{"thinking_blocks":[{"type":"thinking","thinking":"Write to ${TOKEN}","signature":"s\\/ig\\u00e9"}]},"finish_reason":null}]}`;
  const chat = await restoreChatSse(
    sseFrames([
      chatChunk([{ index: 0, delta: { reasoning_content: `Write to ${TOKEN}` }, finish_reason: null }]),
      `${signedChat}\n\n`,
      contentChunk(`Sent to ${TOKEN}`),
      finishChunk(),
      "data: [DONE]\n\n",
    ]),
    emailVault(),
  ).text();
  assert.ok(blocks(chat).includes(signedChat));
  assert.equal(chatText(parsedEvents(chat), 0, (choice) => deltaOf(choice).reasoning_content), `Write to ${EMAIL}`);
  assert.equal(chatText(parsedEvents(chat), 0, contentOf), `Sent to ${EMAIL}`);

  const reasoningDone = `event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":0,"output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"enc-${TOKEN}-\\u00e9"}}`;
  const responses = await restoreResponsesSse(
    sseFrames([
      `${reasoningDone}\n\n`,
      ...responsesFrames(
        [
          summaryDelta("About [EMAIL_"),
          summaryDelta("ADDRESS_1]"),
          { type: "response.reasoning_summary_text.done", item_id: "rs_2", output_index: 1, summary_index: 0, text: `About ${TOKEN}` },
          {
            type: "response.completed",
            response: {
              output: [
                {
                  id: "rs_2",
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: `About ${TOKEN}` }],
                  encrypted_content: `enc-${TOKEN}`,
                },
              ],
            },
          },
        ],
        1,
      ),
    ]),
    emailVault(),
  ).text();
  assert.equal(blocks(responses)[0], reasoningDone);
  const events = parsedEvents(responses);
  assert.equal(responsesText(events, "response.reasoning_summary_text.delta"), `About ${EMAIL}`);
  assert.equal(events.find((event) => event.type === "response.reasoning_summary_text.done")?.text, `About ${EMAIL}`);
  const completed = events.find((event) => event.type === "response.completed")?.response as { output: JsonMap[] };
  assert.equal(completed.output[0]?.encrypted_content, `enc-${TOKEN}`);
  assert.deepEqual(completed.output[0]?.summary, [{ type: "summary_text", text: `About ${EMAIL}` }]);
});

test("DONE markers, comments, and other non-data blocks pass through unchanged", async () => {
  const text = await restoreChatSse(
    sseFrames([
      ": keep-alive\n\n",
      contentChunk("Hi [EMAIL_"),
      "retry: 100\n\n",
      contentChunk("ADDRESS_1]"),
      "data: [DONE]\n\n",
    ]),
    emailVault(),
  ).text();
  const out = blocks(text);
  assert.equal(out[0], ": keep-alive");
  assert.ok(out.includes("retry: 100"));
  assert.equal(out.at(-1), "data: [DONE]");
  assert.equal(chatText(parsedEvents(text), 0, contentOf), `Hi ${EMAIL}`);

  const responses = await restoreResponsesSse(sseFrames([": keep-alive\n\n", "data: [DONE]\n\n"]), emailVault()).text();
  assert.equal(responses, ": keep-alive\n\ndata: [DONE]\n\n");
});

test("a held suffix that never becomes a known placeholder is emitted unchanged", async () => {
  const chat = await restoreChatSse(
    sseFrames([
      contentChunk("See [1"),
      contentChunk("] and [Bad"),
      contentChunk(" idea] or [EMAIL_ADDRESS_"),
      contentChunk("9]"),
      finishChunk(),
      "data: [DONE]\n\n",
    ]),
    emailVault(),
  ).text();
  assert.equal(chatText(parsedEvents(chat), 0, contentOf), "See [1] and [Bad idea] or [EMAIL_ADDRESS_9]");

  const responses = await restoreResponsesSse(
    sseFrames(responsesFrames([textDelta("See [1"), textDelta("] and [EMAIL_ADDRESS_"), textDelta("9]")])),
    emailVault(),
  ).text();
  assert.equal(responsesText(parsedEvents(responses), "response.output_text.delta"), "See [1] and [EMAIL_ADDRESS_9]");
});

test("held text is flushed at the end of the stream and before the finishing chunk", async () => {
  const ended = parsedEvents(await restoreChatSse(sseFrames([contentChunk("Hi [EMAIL_"), argumentsChunk('{"to":"[EM')]), emailVault()).text());
  assert.equal(chatText(ended, 0, contentOf), "Hi [EMAIL_");
  assert.equal(chatText(ended, 0, argumentsOf), '{"to":"[EM');
  assert.equal(ended.at(-1)?.id, "c1");

  const finished = parsedEvents(await restoreChatSse(sseFrames([contentChunk("Hi [EMAIL_"), finishChunk()]), emailVault()).text());
  assert.deepEqual(
    finished.map((event) => (event.choices as JsonMap[])[0]),
    [
      { index: 0, delta: { content: "Hi " }, finish_reason: null },
      { index: 0, delta: { content: "[EMAIL_" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ],
  );

  const closing = parsedEvents(
    await restoreChatSse(
      sseFrames([contentChunk("Hi [EMAIL_"), chatChunk([{ index: 0, delta: { content: "ADDRESS_1]" }, finish_reason: "stop" }])]),
      emailVault(),
    ).text(),
  );
  assert.equal(chatText(closing, 0, contentOf), `Hi ${EMAIL}`);
  assert.equal(closing.length, 2);

  const responses = parsedEvents(await restoreResponsesSse(sseFrames(responsesFrames([textDelta("Hi [EMAIL_")])), emailVault()).text());
  assert.deepEqual(
    responses.map((event) => event.delta),
    ["Hi ", "[EMAIL_"],
  );
  assert.deepEqual(
    responses.map((event) => event.sequence_number),
    [0, 1],
  );
});

test("each chat choice holds and flushes its own pending text", async () => {
  const text = await restoreChatSse(
    sseFrames([
      contentChunk("A [EMAIL_", 0),
      contentChunk("B [EMAIL_ADD", 1),
      contentChunk("ADDRESS_1]", 0),
      contentChunk("[EM", 0),
      finishChunk(0),
      contentChunk("RESS_1]", 1),
      finishChunk(1, "length"),
      "data: [DONE]\n\n",
    ]),
    emailVault(),
  ).text();
  const events = parsedEvents(text);
  assert.equal(chatText(events, 0, contentOf), `A ${EMAIL}[EM`);
  assert.equal(chatText(events, 1, contentOf), `B ${EMAIL}`);
  const order = events.map((event) => {
    const choice = (event.choices as JsonMap[])[0]!;
    return `${String(choice.index)}:${String(choice.finish_reason ?? contentOf(choice))}`;
  });
  assert.ok(order.indexOf("0:[EM") < order.indexOf("0:stop"));
  assert.ok(order.indexOf("0:stop") < order.indexOf(`1:${EMAIL}`));
  assert.ok(order.indexOf(`1:${EMAIL}`) < order.indexOf("1:length"));
});

test("network chunks that split an event mid-JSON still restore", async () => {
  const frame = contentChunk(`Mail ${TOKEN}`);
  const cut = frame.indexOf("ADDRESS");
  const text = await restoreChatSse(sseFrames([frame.slice(0, cut), frame.slice(cut), "data: [DONE]\n\n"]), emailVault()).text();
  assert.equal(chatText(parsedEvents(text), 0, contentOf), `Mail ${EMAIL}`);
});

test("streams pass through untouched without a vault value", () => {
  const chat = sseFrames([contentChunk(TOKEN)]);
  assert.equal(restoreChatSse(chat, null), chat);
  assert.equal(restoreChatSse(chat, new PiiVault()), chat);
  const responses = sseFrames(responsesFrames([textDelta(TOKEN)]));
  assert.equal(restoreResponsesSse(responses, null), responses);
  assert.equal(restoreResponsesSse(responses, new PiiVault()), responses);
});

function controlVault(): PiiVault {
  const vault = new PiiVault();
  vault.placeholder("PERSON", CONTROL);
  vault.placeholder("EMAIL_ADDRESS", EMAIL);
  return vault;
}

function messagesFrames(events: JsonMap[]): string[] {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

function messagesDelta(index: number, delta: JsonMap): JsonMap {
  return { type: "content_block_delta", index, delta };
}

function messagesText(events: JsonMap[], index: number, field: string): string {
  return joined(
    events
      .filter((event) => event.type === "content_block_delta" && event.index === index)
      .map((event) => (event.delta as JsonMap)[field]),
  );
}

test("non-stream restore keeps tool arguments and tool inputs valid JSON in every protocol", () => {
  const vault = controlVault();
  const chat = restoreJson(
    {
      choices: [
        {
          message: {
            content: "Mail [EMAIL_ADDRESS_1]",
            tool_calls: [
              { id: "t1", type: "function", function: { name: "send", arguments: '{"to":"[PERSON_1]","cc":["[EMAIL_ADDRESS_1]"]}' } },
              { id: "t2", type: "function", function: { name: "note", arguments: "free text for [PERSON_1]" } },
            ],
          },
        },
      ],
    },
    vault,
  ) as { choices: { message: { content: string; tool_calls: { function: { arguments: string } }[] } }[] };
  const message = chat.choices[0]!.message;
  assert.equal(message.content, `Mail ${EMAIL}`);
  assert.deepEqual(JSON.parse(message.tool_calls[0]!.function.arguments), { to: CONTROL, cc: [EMAIL] });
  assert.equal(message.tool_calls[1]!.function.arguments, `free text for ${CONTROL}`);

  const messages = restoreJson(
    {
      type: "message",
      content: [
        { type: "text", text: "Sent to [PERSON_1]" },
        { type: "tool_use", id: "toolu_1", name: "send", input: { to: "[PERSON_1]", nested: { list: ["[EMAIL_ADDRESS_1]"] } } },
      ],
    },
    vault,
  ) as { content: JsonMap[] };
  assert.equal(messages.content[0]!.text, `Sent to ${CONTROL}`);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.content[1]!.input)), { to: CONTROL, nested: { list: [EMAIL] } });

  const responses = restoreJson(
    {
      object: "response",
      output: [
        { type: "function_call", call_id: "c1", name: "send", arguments: '{"to":"[PERSON_1]"}' },
        { type: "custom_tool_call", call_id: "c2", name: "shell", input: "echo [PERSON_1]" },
        { type: "mcp_call", id: "m1", name: "lookup", arguments: '{"email":"[EMAIL_ADDRESS_1]"}', output: "Found [EMAIL_ADDRESS_1]" },
      ],
    },
    vault,
  ) as { output: JsonMap[] };
  assert.deepEqual(JSON.parse(String(responses.output[0]!.arguments)), { to: CONTROL });
  assert.equal(responses.output[1]!.input, `echo ${CONTROL}`);
  assert.deepEqual(JSON.parse(String(responses.output[2]!.arguments)), { email: EMAIL });
  assert.equal(responses.output[2]!.output, `Found ${EMAIL}`);
});

test("chat streams restore split placeholders in parallel tool calls with escaped values", async () => {
  const call = (index: number, piece: string, start = false) =>
    chatChunk([
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(start ? { id: `t${index}`, type: "function" } : {}),
              function: { ...(start ? { name: "send" } : {}), arguments: piece },
            },
          ],
        },
        finish_reason: null,
      },
    ]);
  const text = await restoreChatSse(
    sseFrames([
      call(0, '{"to":"[PER', true),
      call(1, '{"cc":"[EMAIL_', true),
      call(0, "SON"),
      call(1, "ADDRESS"),
      call(0, '_1]"}'),
      call(1, '_1]"}'),
      finishChunk(0, "tool_calls"),
      "data: [DONE]\n\n",
    ]),
    controlVault(),
  ).text();
  const events = parsedEvents(text);
  const argumentsFor = (index: number) =>
    joined(
      chatChoices(events, 0).flatMap((choice) =>
        ((deltaOf(choice).tool_calls as JsonMap[] | undefined) ?? [])
          .filter((entry) => entry.index === index)
          .map((entry) => (entry.function as JsonMap).arguments),
      ),
    );
  assert.deepEqual(JSON.parse(argumentsFor(0)), { to: CONTROL });
  assert.deepEqual(JSON.parse(argumentsFor(1)), { cc: EMAIL });
  assert.equal(text.includes("PERSON_"), false);
  assert.equal(text.includes("EMAIL_ADDRESS"), false);
});

test("Messages streams restore split placeholders in text and tool input JSON with escaped values", async () => {
  const text = await restoreMessagesSse(
    sseFrames(
      messagesFrames([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        messagesDelta(0, { type: "text_delta", text: "Sent to [PER" }),
        messagesDelta(0, { type: "text_delta", text: "SON_1] and [EMAIL_ADD" }),
        messagesDelta(0, { type: "text_delta", text: "RESS_1]" }),
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "send", input: {} } },
        messagesDelta(1, { type: "input_json_delta", partial_json: '{"to": "[PERSON' }),
        messagesDelta(1, { type: "input_json_delta", partial_json: "_" }),
        messagesDelta(1, { type: "input_json_delta", partial_json: '1]", "cc": ["[EMAIL_ADDRESS_1]"]}' }),
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ]),
    ),
    controlVault(),
  ).text();
  const events = parsedEvents(text);
  assert.equal(messagesText(events, 0, "text"), `Sent to ${CONTROL} and ${EMAIL}`);
  assert.deepEqual(JSON.parse(messagesText(events, 1, "partial_json")), { to: CONTROL, cc: [EMAIL] });
  assert.equal(text.includes("PERSON_"), false);
  const order = events.map((event) => `${String(event.type)}:${String(event.index ?? "")}`);
  assert.ok(order.lastIndexOf("content_block_delta:1") < order.indexOf("content_block_stop:1"));
  assert.equal(order.at(-1), "message_stop:");

  const ended = parsedEvents(
    await restoreMessagesSse(
      sseFrames(messagesFrames([messagesDelta(0, { type: "input_json_delta", partial_json: '{"to": "[PERSON_' })])),
      controlVault(),
    ).text(),
  );
  assert.equal(messagesText(ended, 0, "partial_json"), '{"to": "[PERSON_');
});

test("Responses streams restore split placeholders in MCP arguments and custom tool input", async () => {
  const mcpDelta = (delta: string): JsonMap => ({ type: "response.mcp_call_arguments.delta", item_id: "mcp_1", output_index: 2, delta });
  const customDelta = (delta: string): JsonMap => ({
    type: "response.custom_tool_call_input.delta",
    item_id: "ctc_1",
    output_index: 3,
    delta,
  });
  const text = await restoreResponsesSse(
    sseFrames(
      responsesFrames([
        mcpDelta('{"who":"[PER'),
        mcpDelta('SON_1]"}'),
        { type: "response.mcp_call_arguments.done", item_id: "mcp_1", output_index: 2, arguments: '{"who":"[PERSON_1]"}' },
        customDelta("ping [EMAIL_"),
        customDelta("ADDRESS_1] as [PERSON_1]"),
        { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 3, input: "ping [EMAIL_ADDRESS_1] as [PERSON_1]" },
      ]),
    ),
    controlVault(),
  ).text();
  const events = parsedEvents(text);
  const mcpDone = events.find((event) => event.type === "response.mcp_call_arguments.done");
  const customDone = events.find((event) => event.type === "response.custom_tool_call_input.done");
  assert.deepEqual(JSON.parse(responsesText(events, "response.mcp_call_arguments.delta")), { who: CONTROL });
  assert.deepEqual(JSON.parse(String(mcpDone?.arguments)), { who: CONTROL });
  assert.equal(responsesText(events, "response.custom_tool_call_input.delta"), `ping ${EMAIL} as ${CONTROL}`);
  assert.equal(customDone?.input, `ping ${EMAIL} as ${CONTROL}`);
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index),
  );
});

test("the restore summary lists the vault and where the reply used each placeholder", () => {
  const vault = controlVault();
  const placeholders = ["[PERSON_1]", "[EMAIL_ADDRESS_1]"];
  assert.equal(piiRestoreSummary(null, {}), null);
  assert.equal(piiRestoreSummary(new PiiVault(), {}), null);
  assert.deepEqual(
    piiRestoreSummary(vault, {
      choices: [
        {
          message: {
            content: "Mail [EMAIL_ADDRESS_1] about [EMAIL_ADDRESS_7]",
            reasoning_content: "Use [PERSON_1]",
            thinking_blocks: [{ type: "thinking", thinking: "[PERSON_1]", signature: "s" }],
            tool_calls: [{ function: { name: "send", arguments: '{"to":"[PERSON_1]"}' } }],
          },
        },
      ],
    }),
    { placeholders, text: ["[EMAIL_ADDRESS_1]", "[PERSON_1]"], tools: ["[PERSON_1]"] },
  );
  assert.deepEqual(
    piiRestoreSummary(vault, {
      type: "message",
      content: [
        { type: "thinking", thinking: "[EMAIL_ADDRESS_1]", signature: "s" },
        { type: "tool_use", id: "toolu_1", name: "send", input: { to: "[EMAIL_ADDRESS_1]" } },
      ],
    }),
    { placeholders, text: [], tools: ["[EMAIL_ADDRESS_1]"] },
  );
  assert.deepEqual(piiRestoreSummary(vault, undefined), { placeholders, text: [], tools: [] });
});

test("a replayed conversation maps every value to the same placeholder on each turn", () => {
  const entities = ["EMAIL_ADDRESS", "IP_ADDRESS"];
  const firstTurn = {
    system: "Help with ops.",
    messages: [{ role: "user", content: "Is 203.0.113.9 up? Mail ada@acme.com." }],
  };
  const first = new PiiVault();
  const sentFirst = redactJSON(firstTurn, entities, "", undefined, first) as typeof firstTurn;
  assert.equal(sentFirst.messages[0]!.content, "Is [IP_ADDRESS_1] up? Mail [EMAIL_ADDRESS_1].");
  const reply = restoreJson(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check [IP_ADDRESS_1]", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ping -c1 [IP_ADDRESS_1]" } },
      ],
    },
    first,
  ) as JsonMap;
  assert.deepEqual((reply.content as JsonMap[])[1]!.input, { command: "ping -c1 203.0.113.9" });
  const secondTurn = {
    system: "Help with ops.",
    messages: [
      ...firstTurn.messages,
      reply,
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "64 bytes from 203.0.113.9; gateway 198.51.100.7" }],
      },
    ],
  };
  const second = new PiiVault();
  const sentSecond = redactJSON(secondTurn, entities, "", undefined, second) as { system: string; messages: JsonMap[] };
  assert.deepEqual(sentSecond.messages[0], sentFirst.messages[0]);
  const echoed = sentSecond.messages[1]!.content as JsonMap[];
  assert.equal(echoed[0]!.thinking, "Check [IP_ADDRESS_1]");
  assert.deepEqual(echoed[1]!.input, { command: "ping -c1 [IP_ADDRESS_1]" });
  const toolResult = (sentSecond.messages[2]!.content as JsonMap[])[0]!;
  assert.equal(toolResult.content, "64 bytes from [IP_ADDRESS_1]; gateway [IP_ADDRESS_2]");
  assert.equal(second.restore("[IP_ADDRESS_1] [IP_ADDRESS_2]"), "203.0.113.9 198.51.100.7");
});

