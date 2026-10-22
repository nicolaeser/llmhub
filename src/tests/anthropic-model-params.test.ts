import { gateway, gatewayRequest, groupRow, resetGateway, UPSTREAM } from "./support/gateway-harness";
import assert from "node:assert/strict";
import test from "node:test";
import { seal } from "@/lib/crypto";
import { prepareBody } from "@/lib/gateway/dispatch/upstream";
import { anthropicParamsFor } from "@/lib/gateway/protocols/anthropic-model-params";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

const OPUS_55 = "claude-opus-5-5";
const ALWAYS_THINKING_FORCED_TOOL_OK = ["claude-fable-5", "claude-mythos-5"];
const ALWAYS_THINKING_NO_FORCED_TOOL = [OPUS_55, "claude-fable-5-1", "claude-mythos-5-1"];
const ALWAYS_THINKING = [...ALWAYS_THINKING_NO_FORCED_TOOL, ...ALWAYS_THINKING_FORCED_TOOL_OK];
const THINKING_OFF_UP_TO_HIGH = ["claude-opus-5", "claude-haiku-5-5"];
const THINKING_OFF_ANY_EFFORT = ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"];
const SONNET_55 = "claude-sonnet-5-5";
const BUDGET_REMOVED = [...ALWAYS_THINKING, SONNET_55, ...THINKING_OFF_UP_TO_HIGH, ...THINKING_OFF_ANY_EFFORT];
const PASS_THROUGH = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-3-7-sonnet-20250219",
  "claude-mythos-preview",
  "claude-opus-5-5-preview",
  "gpt-5",
  "",
];

const MESSAGES = [{ role: "user", content: "Search the web" }];
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

function body(change: JsonMap = {}): JsonMap {
  return { model: "alias", max_tokens: 1024, messages: MESSAGES, ...change };
}

function adjusted(model: string, change: JsonMap): JsonMap {
  return anthropicParamsFor(model, body(change)).body;
}

function effortOf(json: JsonMap): unknown {
  return (json.output_config as JsonMap | undefined)?.effort;
}

test("disabled thinking is omitted at low effort on always-thinking models", () => {
  for (const model of ALWAYS_THINKING) {
    const result = anthropicParamsFor(model, body({ thinking: { type: "disabled" } }));
    assert.equal("thinking" in result.body, false, model);
    assert.equal(effortOf(result.body), "low", model);
    assert.deepEqual(result.adjustments, ["thinking:omitted", "effort:low"], model);

    const chosen = adjusted(model, {
      thinking: { type: "disabled" },
      output_config: { effort: "high", format: { type: "json_schema", schema: {} } },
    });
    assert.equal("thinking" in chosen, false, model);
    assert.deepEqual(chosen.output_config, { effort: "high", format: { type: "json_schema", schema: {} } }, model);
  }
});

test("Sonnet 5.5 turns disabled thinking into between_tools up to high effort", () => {
  for (const effort of [undefined, "low", "medium", "high"]) {
    const output = effort ? { output_config: { effort } } : {};
    const result = anthropicParamsFor(SONNET_55, body({ thinking: { type: "disabled" }, ...output }));
    assert.deepEqual(result.body.thinking, { type: "between_tools" }, String(effort));
    assert.equal(effortOf(result.body), effort, String(effort));
    assert.deepEqual(result.adjustments, ["thinking:between_tools"]);
  }
  for (const effort of ["xhigh", "max"]) {
    const result = anthropicParamsFor(SONNET_55, body({ thinking: { type: "disabled" }, output_config: { effort } }));
    assert.equal("thinking" in result.body, false, effort);
    assert.equal(effortOf(result.body), effort, effort);
    assert.deepEqual(result.adjustments, ["thinking:omitted"]);
  }
});

test("Sonnet 5.5 strips extra fields from between_tools and drops it above high effort", () => {
  const clean = anthropicParamsFor(SONNET_55, body({ thinking: { type: "between_tools" } }));
  assert.deepEqual(clean.adjustments, []);
  const extra = adjusted(SONNET_55, { thinking: { type: "between_tools", display: "summarized" } });
  assert.deepEqual(extra.thinking, { type: "between_tools" });
  const high = adjusted(SONNET_55, { thinking: { type: "between_tools" }, output_config: { effort: "max" } });
  assert.equal("thinking" in high, false);
});

test("Opus 5 and Haiku 5.5 keep disabled thinking up to high effort and omit it above", () => {
  for (const model of THINKING_OFF_UP_TO_HIGH) {
    for (const effort of [undefined, "low", "medium", "high"]) {
      const request = body({ thinking: { type: "disabled" }, ...(effort ? { output_config: { effort } } : {}) });
      const result = anthropicParamsFor(model, request);
      assert.equal(result.body, request, `${model} ${effort}`);
      assert.deepEqual(result.adjustments, []);
    }
    for (const effort of ["xhigh", "max"]) {
      const result = anthropicParamsFor(model, body({ thinking: { type: "disabled" }, output_config: { effort } }));
      assert.equal("thinking" in result.body, false, `${model} ${effort}`);
      assert.equal(effortOf(result.body), effort);
      assert.deepEqual(result.adjustments, ["thinking:omitted"]);
    }
    assert.deepEqual(adjusted(model, { thinking: { type: "between_tools" } }).thinking, { type: "disabled" }, model);
  }
});

test("Opus 4.8, Opus 4.7, and Sonnet 5 accept disabled thinking at every effort", () => {
  for (const model of THINKING_OFF_ANY_EFFORT) {
    for (const effort of [undefined, "high", "xhigh", "max"]) {
      const request = body({ thinking: { type: "disabled" }, ...(effort ? { output_config: { effort } } : {}) });
      assert.equal(anthropicParamsFor(model, request).body, request, `${model} ${effort}`);
    }
    const converted = anthropicParamsFor(model, body({ thinking: { type: "between_tools" } }));
    assert.deepEqual(converted.body.thinking, { type: "disabled" }, model);
    assert.deepEqual(converted.adjustments, ["thinking:disabled"]);
  }
});

test("thinking budgets become adaptive thinking with an effort derived from the budget", () => {
  const ladder: [number, string][] = [
    [1024, "low"],
    [4095, "low"],
    [4096, "medium"],
    [16383, "medium"],
    [16384, "high"],
    [32767, "high"],
    [32768, "xhigh"],
    [64000, "xhigh"],
  ];
  for (const model of BUDGET_REMOVED) {
    for (const [budget, effort] of ladder) {
      const result = anthropicParamsFor(model, body({ thinking: { type: "enabled", budget_tokens: budget } }));
      assert.deepEqual(result.body.thinking, { type: "adaptive" }, `${model} ${budget}`);
      assert.equal(effortOf(result.body), effort, `${model} ${budget}`);
      assert.deepEqual(result.adjustments, ["thinking:adaptive", `effort:${effort}`]);
    }
    const shown = adjusted(model, {
      thinking: { type: "enabled", budget_tokens: 2048, display: "summarized" },
      output_config: { effort: "max" },
    });
    assert.deepEqual(shown.thinking, { type: "adaptive", display: "summarized" }, model);
    assert.equal(effortOf(shown), "max", model);
    const unbudgeted = adjusted(model, { thinking: { type: "enabled" } });
    assert.deepEqual(unbudgeted.thinking, { type: "adaptive" }, model);
    assert.equal("output_config" in unbudgeted, false, model);
  }
});

test("sampling parameters are dropped wherever they were removed", () => {
  for (const model of BUDGET_REMOVED) {
    const result = anthropicParamsFor(model, body({ temperature: 0.2, top_p: 0.9, top_k: 40 }));
    for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in result.body, false, `${model} ${key}`);
    assert.deepEqual(result.adjustments, ["temperature:dropped", "top_p:dropped", "top_k:dropped"]);
    assert.equal("temperature" in adjusted(model, { temperature: 1 }), false, model);
  }
});

test("forced tool choice becomes auto only where the model rejects it", () => {
  for (const model of [...ALWAYS_THINKING_NO_FORCED_TOOL, SONNET_55]) {
    const any = anthropicParamsFor(model, body({ tools: [WEB_SEARCH], tool_choice: { type: "any" } }));
    assert.deepEqual(any.body.tool_choice, { type: "auto" }, model);
    assert.deepEqual(any.adjustments, ["tool_choice:auto"]);
    const named = adjusted(model, {
      tools: [WEB_SEARCH],
      tool_choice: { type: "tool", name: "web_search", disable_parallel_tool_use: true },
    });
    assert.deepEqual(named.tool_choice, { type: "auto", disable_parallel_tool_use: true }, model);
    assert.deepEqual(named.tools, [WEB_SEARCH]);
    for (const choice of [{ type: "auto" }, { type: "none" }]) {
      const request = body({ tool_choice: choice });
      assert.equal(anthropicParamsFor(model, request).body, request, `${model} ${choice.type}`);
    }
  }
  for (const model of [...ALWAYS_THINKING_FORCED_TOOL_OK, ...THINKING_OFF_UP_TO_HIGH, ...THINKING_OFF_ANY_EFFORT]) {
    const request = body({ tool_choice: { type: "tool", name: "web_search" } });
    assert.equal(anthropicParamsFor(model, request).body, request, model);
  }
});

test("dated, Vertex, Bedrock, and display forms of a model id get the same rules", () => {
  for (const model of [
    "claude-opus-5-5-20261001",
    "claude-opus-5-5@20261001",
    "anthropic.claude-opus-5-5",
    "us.anthropic.claude-opus-5-5-v1:0",
    "anthropic.claude-opus-5-5-20261001-v1:0",
    "publishers/anthropic/models/claude-opus-5-5",
    "claude-opus-5-5[1m]",
    " Claude-Opus-5.5 ",
  ]) {
    const result = adjusted(model, { thinking: { type: "disabled" }, tool_choice: { type: "any" } });
    assert.equal("thinking" in result, false, model);
    assert.deepEqual(result.tool_choice, { type: "auto" }, model);
  }
  assert.equal("thinking" in adjusted("claude-opus-5@20260501", { thinking: { type: "disabled" } }), true);
  assert.deepEqual(adjusted("anthropic.claude-sonnet-5-5-v1:0", { thinking: { type: "disabled" } }).thinking, {
    type: "between_tools",
  });
  assert.deepEqual(adjusted("claude-fable-5-1@20260801", { tool_choice: { type: "any" } }).tool_choice, { type: "auto" });
  assert.deepEqual(adjusted("claude-fable-5@20260601", { tool_choice: { type: "any" } }).tool_choice, { type: "any" });
});

test("older and unknown models pass through unchanged", () => {
  for (const model of PASS_THROUGH) {
    const request = body({
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 0.2,
      top_k: 5,
      tool_choice: { type: "tool", name: "web_search" },
    });
    const result = anthropicParamsFor(model, request);
    assert.equal(result.body, request, model);
    assert.deepEqual(result.adjustments, [], model);
    assert.deepEqual(adjusted(model, { thinking: { type: "disabled" } }).thinking, { type: "disabled" }, model);
  }
});

test("normalisation never mutates the caller's body", () => {
  const request = body({
    thinking: { type: "enabled", budget_tokens: 20000, display: "summarized" },
    output_config: { format: { type: "json_schema", schema: {} } },
    temperature: 0.5,
    tools: [WEB_SEARCH],
    tool_choice: { type: "tool", name: "web_search" },
  });
  const snapshot = structuredClone(request);
  for (const model of [OPUS_55, SONNET_55, "claude-opus-5", "claude-opus-4-7"]) {
    const result = anthropicParamsFor(model, request);
    assert.notEqual(result.body, request);
    assert.deepEqual(request, snapshot, model);
  }
  const disabled = body({ thinking: { type: "disabled" }, output_config: { format: { type: "text" } } });
  const disabledSnapshot = structuredClone(disabled);
  const result = anthropicParamsFor(OPUS_55, disabled);
  assert.deepEqual(result.body.output_config, { format: { type: "text" }, effort: "low" });
  assert.deepEqual(disabled, disabledSnapshot);
});

function deployment(kind: string, model: string): ResolvedDeployment {
  return {
    id: `${kind}-route`,
    kind,
    base_url: UPSTREAM,
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: `${kind}-provider`,
  };
}

test("prepareBody normalises native, count_tokens, chat, and Vertex Anthropic bodies for the upstream model", () => {
  const claudeCode = body({
    thinking: { type: "disabled" },
    temperature: 1,
    tools: [WEB_SEARCH],
    tool_choice: { type: "tool", name: "web_search" },
  });
  for (const kind of ["anthropic", "claude"]) {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const sent = prepareBody(deployment(kind, OPUS_55), path, claudeCode);
      assert.equal(sent.model, OPUS_55);
      assert.equal("thinking" in sent, false, `${kind} ${path}`);
      assert.equal("temperature" in sent, false, `${kind} ${path}`);
      assert.deepEqual(sent.tool_choice, { type: "auto" }, `${kind} ${path}`);
      assert.equal(effortOf(sent), "low");
    }
    const older = prepareBody(deployment(kind, "claude-sonnet-4-6"), "/v1/messages", claudeCode);
    assert.deepEqual(older.thinking, { type: "disabled" }, kind);
    assert.deepEqual(older.tool_choice, { type: "tool", name: "web_search" }, kind);
  }

  const chat = {
    model: "alias",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    tool_choice: "required",
    thinking: { type: "disabled" },
  };
  const converted = prepareBody(deployment("claude", SONNET_55), "/chat/completions", chat);
  assert.deepEqual(converted.thinking, { type: "between_tools" });
  assert.deepEqual(converted.tool_choice, { type: "auto" });
  const named = prepareBody(deployment("anthropic", "claude-fable-5-1"), "/chat/completions", {
    ...chat,
    thinking: undefined,
    tool_choice: { type: "function", function: { name: "lookup" } },
  });
  assert.deepEqual(named.tool_choice, { type: "auto" });

  const vertex = prepareBody(deployment("vertex", "claude-opus-5-5@20261001"), "/chat/completions", chat);
  assert.equal(vertex.model, "claude-opus-5-5@20261001");
  assert.equal("thinking" in vertex, false);
  assert.deepEqual(vertex.tool_choice, { type: "auto" });
  assert.equal(effortOf(vertex), "low");
});

function opusRoute(id: string): JsonMap {
  return {
    id,
    kind: "anthropic",
    baseUrl: UPSTREAM,
    model: OPUS_55,
    weight: 1,
    costInput: 0,
    costOutput: 0,
    providerId: `provider-${id}`,
    provider: {
      id: `provider-${id}`,
      kind: "anthropic",
      baseUrl: UPSTREAM,
      apiKey: seal("sk-ant-test"),
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
      assignments: [],
    },
  };
}

test("a Claude Code web search call on an alias for Opus 5.5 reaches the upstream without rejected fields", async () => {
  resetGateway();
  const alias = "claude-code-opus";
  gateway.groups.set(alias, groupRow(alias, { vendor: "anthropic", deployments: [opusRoute("opus-55-route")] }));
  gateway.reply = () =>
    Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: OPUS_55,
      content: [{ type: "text", text: "Found it" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  const { POST } = await import("@/app/api/v1/messages/route");
  const res = await POST(
    gatewayRequest("/api/v1/messages", {
      model: alias,
      max_tokens: 1024,
      messages: MESSAGES,
      thinking: { type: "disabled" },
      tools: [WEB_SEARCH],
      tool_choice: { type: "tool", name: "web_search" },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { model: string }).model, alias);
  assert.equal(gateway.upstream.length, 1);
  assert.match(gateway.upstream[0]!.url, /\/v1\/messages$/);
  const sent = gateway.upstream[0]!.body;
  assert.ok(sent);
  assert.equal(sent.model, OPUS_55);
  assert.equal("thinking" in sent, false);
  assert.deepEqual(sent.tool_choice, { type: "auto" });
  assert.deepEqual(sent.output_config, { effort: "low" });
  assert.deepEqual(sent.tools, [WEB_SEARCH]);
});
