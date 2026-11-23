import { UPSTREAM } from "./support/gateway-harness";
import assert from "node:assert/strict";
import test from "node:test";
import { prepareBody } from "@/lib/gateway/dispatch/upstream";
import { withSingleLeadingSystem } from "@/lib/gateway/protocols/leading-system";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";

function deployment(kind: string, mergeSystemMessages?: boolean): ResolvedDeployment {
  return {
    id: `${kind}-route`,
    kind,
    base_url: UPSTREAM,
    model: "qwen",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: `${kind}-provider`,
    merge_system_messages: mergeSystemMessages,
  };
}

const scattered: JsonMap = {
  model: "qwen",
  messages: [
    { role: "system", content: "be brief" },
    { role: "system", content: [{ type: "text", text: "be kind" }] },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "system", content: "answer in German" },
    { role: "user", content: "next" },
  ],
};

test("system messages fold into one leading message in order", () => {
  assert.deepEqual(withSingleLeadingSystem(scattered).messages, [
    { role: "system", content: "be brief\n\nbe kind\n\nanswer in German" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "next" },
  ]);
});

test("a single leading system message or none leaves the body untouched", () => {
  const leading: JsonMap = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] };
  const bare: JsonMap = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(withSingleLeadingSystem(leading), leading);
  assert.equal(withSingleLeadingSystem(bare), bare);
  assert.equal(withSingleLeadingSystem({ prompt: "hi" }).prompt, "hi");
});

test("a lone late system message moves to the front and empty ones drop", () => {
  const late: JsonMap = { messages: [{ role: "user", content: "hi" }, { role: "system", content: "rules" }] };
  assert.deepEqual(withSingleLeadingSystem(late).messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
  ]);
  const empty: JsonMap = { messages: [{ role: "user", content: "hi" }, { role: "system", content: "" }] };
  assert.deepEqual(withSingleLeadingSystem(empty).messages, [{ role: "user", content: "hi" }]);
  const emptyLeading: JsonMap = { messages: [{ role: "system", content: "" }, { role: "user", content: "hi" }] };
  const dropped = withSingleLeadingSystem(emptyLeading);
  assert.notEqual(dropped, emptyLeading);
  assert.deepEqual(dropped.messages, [{ role: "user", content: "hi" }]);
});

test("developer messages and array-content leading system messages normalize to a single string system message", () => {
  const dev: JsonMap = { messages: [{ role: "developer", content: "follow rules" }, { role: "user", content: "hi" }] };
  const normalizedDev = withSingleLeadingSystem(dev);
  assert.notEqual(normalizedDev, dev);
  assert.deepEqual(normalizedDev.messages, [
    { role: "system", content: "follow rules" },
    { role: "user", content: "hi" },
  ]);

  const mixed: JsonMap = {
    messages: [
      { role: "developer", content: "first" },
      { role: "user", content: "hi" },
      { role: "system", content: "second" },
      { role: "assistant", content: "hello" },
      { role: "developer", content: [{ type: "text", text: "third" }] },
    ],
  };
  assert.deepEqual(withSingleLeadingSystem(mixed).messages, [
    { role: "system", content: "first\n\nsecond\n\nthird" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);

  const arraySystem: JsonMap = {
    messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }, { role: "user", content: "hi" }],
  };
  const normalizedArray = withSingleLeadingSystem(arraySystem);
  assert.notEqual(normalizedArray, arraySystem);
  assert.deepEqual(normalizedArray.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

test("only models with merged system messages receive a single system message", () => {
  const systemCount = (body: JsonMap) => (body.messages as JsonMap[]).filter((message) => message.role === "system").length;
  const merged = prepareBody(deployment("openai_compat", true), "/chat/completions", scattered);
  assert.equal(systemCount(merged), 1);
  assert.equal((merged.messages as JsonMap[])[0].role, "system");
  assert.equal(systemCount(prepareBody(deployment("openai", true), "/chat/completions", scattered)), 1);
  assert.equal(systemCount(prepareBody(deployment("openai_compat", false), "/chat/completions", scattered)), 3);
  assert.equal(systemCount(prepareBody(deployment("openai_compat"), "/chat/completions", scattered)), 3);
});

test("prepareBody leaves anthropic routes and non-chat paths untouched when merge_system_messages is true", () => {
  const cachedSystem: JsonMap = {
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "be kind" },
      { role: "user", content: "hi" },
    ],
  };
  const anthropicMerged = prepareBody(deployment("anthropic", true), "/chat/completions", cachedSystem);
  const anthropicPlain = prepareBody(deployment("anthropic", false), "/chat/completions", cachedSystem);
  assert.deepEqual(anthropicMerged, anthropicPlain);
  assert.equal(Array.isArray(anthropicMerged.system), true);
  assert.equal((anthropicMerged.system as JsonMap[]).length, 2);

  const nativeMessages: JsonMap = {
    model: "claude-sonnet-4-6",
    system: "sys",
    messages: [{ role: "developer", content: "dev" }, { role: "user", content: "hi" }],
  };
  assert.deepEqual(
    prepareBody(deployment("anthropic", true), "/v1/messages", nativeMessages),
    prepareBody(deployment("anthropic", false), "/v1/messages", nativeMessages),
  );

  const embedded = prepareBody(deployment("openai_compat", true), "/embeddings", scattered);
  assert.deepEqual(embedded.messages, scattered.messages);
});
