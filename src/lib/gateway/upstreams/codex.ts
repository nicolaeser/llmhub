import { asNumber, asRecord, asString, asStringArray, newId, stringifyContent } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { chatMessagesToItems } from "@/lib/gateway/protocols/responses";
import { isCodexSignature } from "@/lib/gateway/protocols/reasoning-signature";
import { completionFromSse } from "@/lib/gateway/protocols/sse-completion";
import type { ChatSseTranslator, JsonMap, ReasoningSignatureCheck, ResponsesStreamOptions } from "@/types/gateway";
import type { ModelFacts } from "@/types/routing";

export const CODEX_DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
export const CODEX_CLIENT_VERSION = "0.161.0";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_FAST_TIER = "priority";
export const CODEX_ULTRAFAST_TIER = "ultrafast";

const CODEX_LEGACY_FAST_TIER = "fast";
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const REASONING_DELTAS = new Set(["response.reasoning_summary_text.delta", "response.reasoning_text.delta"]);
const FINAL_EVENTS = new Set(["response.completed", "response.incomplete"]);
function reasoningItems(message: JsonMap, isSignature: ReasoningSignatureCheck): JsonMap[] {
  if (asString(message.role) !== "assistant" || !Array.isArray(message.thinking_blocks)) return [];
  const items: JsonMap[] = [];
  for (const raw of message.thinking_blocks) {
    const block = asRecord(raw);
    if (block?.type !== "thinking" || !isSignature(block.signature)) continue;
    items.push({ type: "reasoning", summary: [], encrypted_content: block.signature });
  }
  return items;
}

function codexInput(messages: JsonMap[], isSignature: ReasoningSignatureCheck): JsonMap[] {
  return messages.flatMap((message) => [...reasoningItems(message, isSignature), ...chatMessagesToItems([message])]);
}

function summaryText(item: JsonMap): string {
  const parts = Array.isArray(item.summary) ? item.summary : [];
  return parts
    .map((part) => asString(asRecord(part)?.text))
    .filter(Boolean)
    .join("\n\n");
}

function codexTools(tools: unknown): JsonMap[] {
  const out: JsonMap[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = asRecord(raw);
    const fn = asRecord(tool?.function);
    if (tool?.type !== "function" || typeof fn?.name !== "string") continue;
    const mapped: JsonMap = { type: "function", name: fn.name, parameters: fn.parameters ?? { type: "object" } };
    if (typeof fn.description === "string") mapped.description = fn.description;
    if (typeof fn.strict === "boolean") mapped.strict = fn.strict;
    out.push(mapped);
  }
  return out;
}

function codexToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  const name = asString(asRecord(asRecord(choice)?.function)?.name);
  return name ? { type: "function", name } : undefined;
}

function codexEffort(value: unknown): string {
  const effort = asString(value);
  return effort === "max" ? "xhigh" : effort;
}

function codexText(body: JsonMap): JsonMap | null {
  const text: JsonMap = {};
  const format = asRecord(body.response_format);
  if (format?.type === "json_object") text.format = { type: "json_object" };
  const schema = asRecord(format?.json_schema);
  if (format?.type === "json_schema" && schema) {
    const mapped: JsonMap = { type: "json_schema", name: asString(schema.name, "response"), schema: schema.schema ?? {} };
    if (typeof schema.description === "string") mapped.description = schema.description;
    if (typeof schema.strict === "boolean") mapped.strict = schema.strict;
    text.format = mapped;
  }
  if (typeof body.verbosity === "string") text.verbosity = body.verbosity;
  return Object.keys(text).length ? text : null;
}

export function chatToCodex(body: JsonMap, isSignature: ReasoningSignatureCheck = isCodexSignature): JsonMap {
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(asRecord)
    .filter((message): message is JsonMap => message !== null);
  const instructions = messages
    .filter((message) => INSTRUCTION_ROLES.has(asString(message.role)))
    .map((message) => stringifyContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const payload: JsonMap = {
    model: body.model,
    instructions: instructions || CODEX_DEFAULT_INSTRUCTIONS,
    input: codexInput(
      messages.filter((message) => !INSTRUCTION_ROLES.has(asString(message.role))),
      isSignature,
    ),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  const tools = codexTools(body.tools);
  if (tools.length) {
    payload.tools = tools;
    const choice = codexToolChoice(body.tool_choice);
    if (choice !== undefined) payload.tool_choice = choice;
    if (typeof body.parallel_tool_calls === "boolean") payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  const search = asRecord(body.web_search);
  if (search) {
    const tool: JsonMap = { type: "web_search" };
    const domains = asStringArray(search.allowed_domains);
    if (domains.length) tool.filters = { allowed_domains: domains };
    const location = asRecord(search.user_location);
    if (location) tool.user_location = { ...location, type: "approximate" };
    payload.tools = [...(Array.isArray(payload.tools) ? payload.tools : []), tool];
    payload.include = ["reasoning.encrypted_content", "web_search_call.action.sources"];
    if (search.forced === true) payload.tool_choice = { type: "web_search" };
  }
  const effort = codexEffort(body.reasoning_effort) || codexEffort(asRecord(body.reasoning)?.effort);
  payload.reasoning = effort ? { effort, summary: "auto" } : { summary: "auto" };
  const text = codexText(body);
  if (text) payload.text = text;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
    payload.prompt_cache_key = body.prompt_cache_key;
  }
  if (typeof body.service_tier === "string" && body.service_tier) payload.service_tier = body.service_tier;
  const programs = asRecord(body.access_programs);
  if (typeof programs?.cyber === "string" && programs.cyber) payload.access_programs = { cyber: programs.cyber };
  return payload;
}

export function codexModelFacts(model: JsonMap): ModelFacts {
  const facts: ModelFacts = {};
  const tiers = Array.isArray(model.service_tiers)
    ? model.service_tiers.map((tier) => asString(asRecord(tier)?.id)).filter(Boolean)
    : null;
  const legacy = Array.isArray(model.additional_speed_tiers)
    ? asStringArray(model.additional_speed_tiers).includes(CODEX_LEGACY_FAST_TIER)
      ? [CODEX_FAST_TIER]
      : []
    : null;
  if (tiers || legacy) facts.serviceTiers = [...new Set([...(tiers ?? []), ...(legacy ?? [])])];
  const programs = asRecord(model.available_access_programs);
  if (programs && Array.isArray(programs.cyber)) facts.accessPrograms = asStringArray(programs.cyber);
  return facts;
}

export function chatUsageFromResponses(usage: unknown): JsonMap {
  const rec = asRecord(usage);
  const prompt = asNumber(rec?.input_tokens, 0);
  const completion = asNumber(rec?.output_tokens, 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(rec?.total_tokens, prompt + completion),
    prompt_tokens_details: { cached_tokens: asNumber(asRecord(rec?.input_tokens_details)?.cached_tokens, 0) },
    completion_tokens_details: {
      reasoning_tokens: asNumber(asRecord(rec?.output_tokens_details)?.reasoning_tokens, 0),
    },
  };
}

function failureMessage(data: JsonMap): string {
  const error = asRecord(data.error) ?? asRecord(asRecord(data.response)?.error);
  return asString(error?.message) || asString(data.message) || "upstream response failed";
}

export class CodexSseTranslator implements ChatSseTranslator {
  private event = "";
  private data = "";
  private id = `chatcmpl_${newId()}`;
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  private tools = new Map<number, { slot: number; streamed: boolean }>();
  private isSignature: ReasoningSignatureCheck;

  constructor(
    private model: string,
    private options: ResponsesStreamOptions = {},
  ) {
    this.isSignature = options.isSignature ?? isCodexSignature;
  }

  pushLine(raw: string): string[] {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) {
      const flushed = this.flush();
      return flushed ? [flushed] : [];
    }
    if (line.startsWith(":")) return [];
    if (line.startsWith("event:")) {
      const pending = this.data ? this.flush() : null;
      this.event = line.slice(6).trim();
      return pending ? [pending] : [];
    }
    if (line.startsWith("data:")) {
      if (this.data) this.data += "\n";
      this.data += line.slice(5).trim();
    }
    return [];
  }

  flush(): string | null {
    const payload = this.data.trim();
    const event = this.event;
    this.data = "";
    this.event = "";
    if (!payload || payload === "[DONE]") return null;
    let parsed: JsonMap;
    try {
      parsed = JSON.parse(payload) as JsonMap;
    } catch {
      return null;
    }
    const type = asString(parsed.type) || event;
    this.options.onEvent?.(type, parsed);
    return this.translate(type, parsed);
  }

  private chunk(delta: JsonMap): string {
    const role = this.started ? {} : { role: "assistant" };
    this.started = true;
    return JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { ...role, ...delta }, logprobs: null, finish_reason: null }],
    });
  }

  private toolSlot(outputIndex: number): { slot: number; streamed: boolean; fresh: boolean } {
    const existing = this.tools.get(outputIndex);
    if (existing) return { ...existing, fresh: false };
    const created = { slot: this.tools.size, streamed: false };
    this.tools.set(outputIndex, created);
    return { ...created, fresh: true };
  }

  private finish(data: JsonMap): string {
    const response = asRecord(data.response) ?? {};
    const reason = asString(asRecord(response.incomplete_details)?.reason);
    const finish = this.tools.size
      ? "tool_calls"
      : reason === "max_output_tokens"
        ? "length"
        : reason === "content_filter"
          ? "content_filter"
          : "stop";
    return JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finish }],
      usage: chatUsageFromResponses(response.usage),
    });
  }

  private translate(type: string, data: JsonMap): string | null {
    if (type === "error" || type === "response.failed") {
      throw this.options.failure?.(data) ?? new GateError(502, "upstream_error", failureMessage(data));
    }
    if (type === "response.created") return this.started ? null : this.chunk({ content: "" });
    if (type === "response.output_text.delta") {
      const delta = asString(data.delta);
      return delta ? this.chunk({ content: delta }) : null;
    }
    if (REASONING_DELTAS.has(type)) {
      const delta = asString(data.delta);
      return delta ? this.chunk({ reasoning_content: delta }) : null;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = asRecord(data.item);
      if (item?.type === "web_search_call") {
        if (type !== "response.output_item.done") return null;
        const action = asRecord(item.action);
        const sources = (Array.isArray(action?.sources) ? action.sources : [])
          .map(asRecord)
          .filter((source): source is JsonMap => source !== null && asString(source.url) !== "")
          .map((source) => ({ url: asString(source.url), title: asString(source.title) }));
        return this.chunk({
          web_search_calls: [{ id: asString(item.id) || `ws_${newId()}`, query: asString(action?.query), sources }],
        });
      }
      if (item?.type === "reasoning") {
        if (type !== "response.output_item.done" || !this.isSignature(item.encrypted_content)) return null;
        return this.chunk({
          thinking_blocks: [{ type: "thinking", thinking: summaryText(item), signature: item.encrypted_content }],
        });
      }
      if (item?.type !== "function_call") return null;
      const outputIndex = asNumber(data.output_index, this.tools.size);
      const tool = this.toolSlot(outputIndex);
      const args = asString(item.arguments);
      const done = type === "response.output_item.done";
      if (!tool.fresh && (!done || tool.streamed || !args)) return null;
      if (done) this.tools.set(outputIndex, { slot: tool.slot, streamed: true });
      const call: JsonMap = { index: tool.slot, function: { arguments: done ? args : "" } };
      if (tool.fresh) {
        call.id = asString(item.call_id) || asString(item.id) || `call_${newId()}`;
        call.type = "function";
        call.function = { name: asString(item.name), arguments: done ? args : "" };
      }
      return this.chunk({ tool_calls: [call] });
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = asString(data.delta);
      const outputIndex = asNumber(data.output_index, -1);
      const tool = this.tools.get(outputIndex);
      if (!tool || !delta) return null;
      this.tools.set(outputIndex, { slot: tool.slot, streamed: true });
      return this.chunk({ tool_calls: [{ index: tool.slot, function: { arguments: delta } }] });
    }
    if (FINAL_EVENTS.has(type)) return this.finish(data);
    return null;
  }
}

export function codexCompletion(text: string, model: string, options: ResponsesStreamOptions = {}): JsonMap {
  return completionFromSse(new CodexSseTranslator(model, options), text, model);
}
