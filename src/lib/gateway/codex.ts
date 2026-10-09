import { asNumber, asRecord, asString, newId, stringifyContent } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { ChatStreamTranscript } from "@/lib/gateway/log-content";
import { chatMessagesToItems } from "@/lib/gateway/responses";
import type { ChatSseTranslator, JsonMap } from "@/types/gateway";

export const CODEX_DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
export const CODEX_CLIENT_VERSION = "0.161.0";

const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const REASONING_DELTAS = new Set(["response.reasoning_summary_text.delta", "response.reasoning_text.delta"]);
const FINAL_EVENTS = new Set(["response.completed", "response.incomplete"]);

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

export function chatToCodex(body: JsonMap): JsonMap {
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
    input: chatMessagesToItems(messages.filter((message) => !INSTRUCTION_ROLES.has(asString(message.role)))),
    store: false,
    stream: true,
  };
  const tools = codexTools(body.tools);
  if (tools.length) {
    payload.tools = tools;
    const choice = codexToolChoice(body.tool_choice);
    if (choice !== undefined) payload.tool_choice = choice;
    if (typeof body.parallel_tool_calls === "boolean") payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  const effort = codexEffort(body.reasoning_effort) || codexEffort(asRecord(body.reasoning)?.effort);
  payload.reasoning = effort ? { effort, summary: "auto" } : { summary: "auto" };
  const text = codexText(body);
  if (text) payload.text = text;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
    payload.prompt_cache_key = body.prompt_cache_key;
  }
  return payload;
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

  constructor(private model: string) {}

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
    return this.translate(asString(parsed.type) || event, parsed);
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
      throw new GateError(502, "upstream_error", failureMessage(data));
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

export function codexCompletion(text: string, model: string): JsonMap {
  const translator = new CodexSseTranslator(model);
  const transcript = new ChatStreamTranscript();
  let last: JsonMap | null = null;
  const take = (payload: string) => {
    const chunk = JSON.parse(payload) as JsonMap;
    transcript.push(chunk);
    last = chunk;
  };
  for (const line of text.split("\n")) for (const payload of translator.pushLine(line)) take(payload);
  const flushed = translator.flush();
  if (flushed) take(flushed);
  const final = asRecord(last);
  const choice = asRecord((Array.isArray(final?.choices) ? final.choices : [])[0]);
  const finish = asString(choice?.finish_reason);
  if (!final || !finish) throw new GateError(502, "upstream_error", "upstream stream ended before the response completed");
  const result = transcript.result();
  const assembled = Array.isArray(result?.choices) ? asRecord(result.choices[0]) : null;
  const message = asRecord(assembled?.message) ?? { role: "assistant", content: "" };
  return {
    id: final.id,
    object: "chat.completion",
    created: final.created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: final.usage,
  };
}
