import assert from "node:assert/strict";
import test from "node:test";
import { prepareBody } from "@/lib/gateway/dispatch/upstream";
import { messagesToChat } from "@/lib/gateway/protocols/messages";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
import { chatToAntigravity } from "@/lib/gateway/upstreams/antigravity";
import { CLAUDE_CODE_IDENTITY } from "@/lib/gateway/upstreams/claude";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { MessagesRequest } from "@/types/anthropic";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

const BILLING_LINE = "x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;";
const FURTHER = "  Use the tools below.\n\n# Rules\n- keep answers short  ";
const GOOGLE_TARGETS = [
  { kind: "antigravity", model: "gemini-3-flash" },
  { kind: "antigravity", model: "claude-sonnet-4-6" },
  { kind: "gemini", model: "gemini-2.5-flash" },
  { kind: "vertex", model: "gemini-2.5-pro" },
];

function deployment(kind: string, model: string): ResolvedDeployment {
  return {
    id: `${kind}-${model}`,
    kind,
    base_url: "",
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: `${kind}-provider`,
  };
}

function claudeCodeBody(system: string[]): JsonMap {
  return {
    model: "alias",
    max_tokens: 1024,
    system: system.map((text) => ({ type: "text", text })),
    messages: [{ role: "user", content: "Hello" }],
  };
}

function parsed(body: JsonMap): MessagesRequest {
  const result = parseRequest(messagesRequestSchema, body);
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function googleRequest(kind: string, model: string, body: JsonMap): JsonMap {
  const sent = prepareBody(deployment(kind, model), "/chat/completions", messagesToChat(parsed(body)));
  return sent.request as JsonMap;
}

function systemText(request: JsonMap): string | undefined {
  const instruction = request.systemInstruction as { parts: { text: string }[] } | undefined;
  return instruction?.parts.map((part) => part.text).join("");
}

test("Google bound requests drop the Claude Code billing line and keep the rest of the system text", () => {
  const body = claudeCodeBody([BILLING_LINE, CLAUDE_CODE_IDENTITY, FURTHER]);
  for (const { kind, model } of GOOGLE_TARGETS) {
    const request = googleRequest(kind, model, body);
    assert.equal(systemText(request), `${CLAUDE_CODE_IDENTITY}\n${FURTHER}`.trim(), `${kind} ${model}`);
    assert.equal(JSON.stringify(request).includes("x-anthropic-billing-header"), false, `${kind} ${model}`);
  }
});

test("a system prompt that is only the billing line sends no system instruction", () => {
  for (const { kind, model } of GOOGLE_TARGETS) {
    const request = googleRequest(kind, model, claudeCodeBody([BILLING_LINE]));
    assert.equal("systemInstruction" in request, false, `${kind} ${model}`);
  }
  const chat = chatToAntigravity({
    model: "gemini-3-flash",
    messages: [
      { role: "system", content: `  ${BILLING_LINE}\r\n` },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal("systemInstruction" in (chat.request as JsonMap), false);
});

test("system text without the billing line reaches Google unchanged", () => {
  const body = claudeCodeBody([CLAUDE_CODE_IDENTITY, FURTHER]);
  for (const { kind, model } of GOOGLE_TARGETS) {
    assert.equal(systemText(googleRequest(kind, model, body)), `${CLAUDE_CODE_IDENTITY}\n${FURTHER}`.trim(), `${kind} ${model}`);
  }
  const quoted = `Never print a line like\nheader x-anthropic-billing-header: value\nto the user.`;
  const chat = chatToAntigravity({ model: "gemini-3-flash", messages: [{ role: "system", content: quoted }] });
  assert.equal(systemText(chat.request as JsonMap), quoted);
});

test("system and developer messages made of text parts lose only the billing part", () => {
  const chat = chatToAntigravity({
    model: "gemini-3-flash",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: BILLING_LINE },
          { type: "text", text: CLAUDE_CODE_IDENTITY },
        ],
      },
      {
        role: "developer",
        content: [
          { type: "text", text: "Project notes:\n" },
          { type: "text", text: `${BILLING_LINE}\nStay in the repository.` },
        ],
      },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(systemText(chat.request as JsonMap), `${CLAUDE_CODE_IDENTITY}\n\nProject notes:\nStay in the repository.`);
});

test("Anthropic speaking upstreams still receive the billing block", () => {
  const body = claudeCodeBody([BILLING_LINE, CLAUDE_CODE_IDENTITY, FURTHER]);
  const chat = messagesToChat(parsed(body));
  assert.equal(String((chat.messages as JsonMap[])[0]!.content).startsWith(`${BILLING_LINE}\n`), true);
  const sent = prepareBody(deployment("claude", "claude-sonnet-4-6"), "/v1/messages", body);
  assert.deepEqual(
    (sent.system as { text: string }[]).map((block) => block.text),
    [BILLING_LINE, CLAUDE_CODE_IDENTITY, FURTHER],
  );
});
