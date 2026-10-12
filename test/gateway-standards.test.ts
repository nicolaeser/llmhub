import assert from "node:assert/strict";
import test from "node:test";
import { nativeMessagesBody } from "@/lib/gateway/anthropic";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { modelEntry } from "@/lib/gateway/core";
import { costOf } from "@/lib/gateway/cost";
import { mediaTypeOf } from "@/lib/gateway/file-refs";
import { OutputScreen } from "@/lib/gateway/guardrails";
import { mergeStreamUsage, screenMessage, screenMessageEvent } from "@/lib/gateway/messages-dispatch";
import { redactJSON } from "@/lib/gateway/pii";
import { applyProviderServiceMode } from "@/lib/gateway/service-mode";
import { normalizeEnterprise } from "@/lib/gateway/settings";
import { joinPath, mergeUpstreamHeaders, prepareBody, upstreamErrorMessage } from "@/lib/gateway/upstream";
import type { Deployment, JsonMap, ResolvedDeployment } from "@/types/gateway";

function dep(kind: string, base_url = "", model = "m"): ResolvedDeployment {
  return {
    id: kind,
    kind,
    base_url,
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: "",
  };
}

test("typesafe is a catalog kind with the TypeSafe API base", () => {
  const spec = PROVIDER_CATALOG.find((row) => row.kind === "typesafe");
  assert.deepEqual(spec, { kind: "typesafe", name: "TypeSafe AI", default_base_url: "https://api.typesafe.ai" });
  assert.equal(joinPath(dep("typesafe"), "/systemone"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(
    joinPath(dep("openai_compat", "https://ai-gateway.vercel.sh/typesafe"), "/systemone"),
    "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  );
  assert.equal(joinPath(dep("openrouter"), "/systemone"), "https://openrouter.ai/api/v1/systemone");
});

test("typesafe drops service tier hints the TypeSafe API does not define", () => {
  const mapped = applyProviderServiceMode("typesafe", { service_tier: "priority", speed: "fast" }, "fast");
  assert.equal(mapped.body.service_tier, undefined);
  assert.equal(mapped.body.speed, undefined);
});

test("prepareBody strips gateway routing keys and foreign thinking blocks", () => {
  const body = {
    model: "alias",
    fallbacks: ["b"],
    fallback: "c",
    tags: ["team-a"],
    tag: "x",
    messages: [
      { role: "assistant", content: "x", thinking_blocks: [{ type: "thinking", thinking: "t", signature: "s" }] },
    ],
  };
  const openai = prepareBody(dep("openai", "", "gpt"), "/chat/completions", body);
  assert.equal(openai.model, "gpt");
  assert.equal("fallbacks" in openai, false);
  assert.equal("fallback" in openai, false);
  assert.equal("tags" in openai, false);
  assert.equal("tag" in openai, false);
  assert.deepEqual(openai.messages, [{ role: "assistant", content: "x" }]);
  const claude = prepareBody(dep("anthropic", "", "claude-opus-4-8"), "/chat/completions", body);
  assert.deepEqual((claude.messages as JsonMap[])[0]!.content, [
    { type: "thinking", thinking: "t", signature: "s" },
    { type: "text", text: "x" },
  ]);
  const native = prepareBody(dep("anthropic", "", "claude-opus-4-8"), "/v1/messages", {
    model: "alias",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
  });
  assert.deepEqual(native, {
    model: "claude-opus-4-8",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
  });
  assert.equal(joinPath(dep("anthropic"), "/v1/messages/count_tokens"), "https://api.anthropic.com/v1/messages/count_tokens");
});

test("anthropic-beta values merge instead of overwriting", () => {
  assert.deepEqual(
    mergeUpstreamHeaders(
      { "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "k" },
      { "anthropic-beta": "fast-mode-2026-02-01,context-1m-2025-08-07" },
    ),
    { "anthropic-beta": "context-1m-2025-08-07,fast-mode-2026-02-01", "x-api-key": "k" },
  );
});

test("upstream error messages read OpenAI, Anthropic, TypeSafe, and gateway shapes", () => {
  assert.equal(upstreamErrorMessage(400, { error: { message: "bad" } }), "bad");
  assert.equal(upstreamErrorMessage(400, { type: "error", error: { type: "x", message: "nope" } }), "nope");
  assert.equal(upstreamErrorMessage(401, { error: "denied" }), "denied");
  assert.equal(
    upstreamErrorMessage(422, { detail: [{ loc: ["body", "questions"], msg: "Field required", type: "missing" }] }),
    "body.questions: Field required",
  );
  assert.equal(
    upstreamErrorMessage(403, { detail: { error_type: "authentication_error", message: "Must supply an API key!" } }),
    "Must supply an API key!",
  );
  assert.equal(upstreamErrorMessage(400, { message: "questions.x.type: invalid", error_type: "invalid_request" }), "questions.x.type: invalid");
  assert.equal(upstreamErrorMessage(502, {}), "upstream returned 502");
});

test("usage parsing keeps cache writes, 1h writes, and Responses cached tokens", () => {
  assert.deepEqual(
    usageFromUnknown({
      prompt_tokens: 100,
      completion_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    }),
    {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_creation_1h_input_tokens: 20,
    },
  );
  const responses = usageFromUnknown({ input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } });
  assert.equal(responses.cache_read_input_tokens, 40);
  const jev = usageFromUnknown({ input_tokens: 296, output_tokens: 20 });
  assert.equal(jev.prompt_tokens, 296);
  assert.equal(jev.completion_tokens, 20);
});

test("cache writes bill at 1.25x for 5 minutes and 2x for 1 hour", () => {
  const rates: Deployment = { ...dep("anthropic"), cost_input_per_1k: 1, cost_output_per_1k: 0 };
  const cost = costOf(rates, {
    prompt_tokens: 4000,
    completion_tokens: 0,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_creation_1h_input_tokens: 1000,
  });
  assert.equal(cost, 1 + 0.1 + 1.25 + 2);
});

test("object retention defaults keep uploads and expire generated objects after 30 days", () => {
  const defaults = normalizeEnterprise({});
  assert.equal(defaults.object_retention_days, 30);
  assert.equal(defaults.file_retention_days, 0);
  const custom = normalizeEnterprise({ object_retention_days: 7, file_retention_days: 90 });
  assert.equal(custom.object_retention_days, 7);
  assert.equal(custom.file_retention_days, 90);
});

test("input redaction leaves signed reasoning and opaque ids untouched", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "mail jane@example.com", signature: "sig" }],
      },
      { role: "user", content: "mail jane@example.com", tool_use_id: "toolu_555-0100" },
    ],
  };
  const out = redactJSON(body) as { messages: JsonMap[] };
  const thinking = (out.messages[0]!.content as JsonMap[])[0]!;
  assert.equal(thinking.thinking, "mail jane@example.com");
  assert.notEqual(out.messages[1]!.content, "mail jane@example.com");
  assert.equal(out.messages[1]!.tool_use_id, "toolu_555-0100");
});

test("native Messages output redaction covers text but never signed thinking", () => {
  const screen = new OutputScreen({ pii: ["EMAIL_ADDRESS"], rules: [] });
  const message = screenMessage(
    {
      content: [
        { type: "thinking", thinking: "jane@example.com", signature: "s" },
        { type: "text", text: "write to jane@example.com" },
      ],
    },
    screen,
  );
  const blocks = message.content as JsonMap[];
  assert.equal(blocks[0]!.thinking, "jane@example.com");
  assert.doesNotMatch(String(blocks[1]!.text), /jane@example\.com/);
  const delta = screenMessageEvent(
    { type: "content_block_delta", delta: { type: "text_delta", text: "jane@example.com" } },
    new OutputScreen({ pii: ["EMAIL_ADDRESS"], rules: [] }),
  );
  assert.doesNotMatch(String((delta.delta as JsonMap).text), /jane@example\.com/);
  const thinking = screenMessageEvent(
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "jane@example.com" } },
    screen,
  );
  assert.equal((thinking.delta as JsonMap).thinking, "jane@example.com");
});

test("streamed Messages usage keeps start counts when the delta reports zeros", () => {
  const usage: JsonMap = {};
  mergeStreamUsage(usage, { input_tokens: 12, cache_read_input_tokens: 4, output_tokens: 1 });
  mergeStreamUsage(usage, { input_tokens: 0, output_tokens: 40, output_tokens_details: { thinking_tokens: 30 } });
  assert.deepEqual(usage, {
    input_tokens: 12,
    cache_read_input_tokens: 4,
    output_tokens: 40,
    output_tokens_details: { thinking_tokens: 30 },
  });
});

test("gateway file media types come from the stored type or the filename", () => {
  assert.equal(mediaTypeOf("image/png", "x.bin"), "image/png");
  assert.equal(mediaTypeOf("", "scan.PDF"), "application/pdf");
  assert.equal(mediaTypeOf("application/octet-stream", "photo.jpeg"), "image/jpeg");
  assert.equal(mediaTypeOf("", "blob"), "application/octet-stream");
});

test("native Messages bodies drop gateway-only routing and tagging fields", () => {
  assert.deepEqual(
    nativeMessagesBody({
      model: "m",
      max_tokens: 5,
      messages: [],
      tags: ["team-a"],
      tag: "x",
      user: "u",
      fallbacks: ["b"],
      metadata: { user_id: "end-user", tag: "x" },
      context_management: { edits: [] },
    }),
    { model: "m", max_tokens: 5, messages: [], metadata: { user_id: "end-user" }, context_management: { edits: [] } },
  );
  assert.equal("metadata" in nativeMessagesBody({ metadata: { tag: "x" } }), false);
});

test("model entries satisfy OpenAI and Anthropic model list readers", () => {
  const created = new Date("2026-10-01T00:00:00.000Z");
  assert.deepEqual(modelEntry("claude-alias", created), {
    id: "claude-alias",
    object: "model",
    created: 1790812800,
    owned_by: "llm-hub",
    type: "model",
    display_name: "claude-alias",
    created_at: "2026-10-01T00:00:00.000Z",
  });
});
