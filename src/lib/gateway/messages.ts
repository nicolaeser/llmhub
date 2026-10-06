import { parseToolInput } from "@/lib/gateway/anthropic";
import { asRecord, newId, stringifyContent } from "@/lib/gateway/core";
import { anthropicErrorBody } from "@/lib/gateway/errors";
import { sseEvent, ToolCallDeltas } from "@/lib/gateway/responses";
import type {
  AnthropicUsage,
  MessagesContentBlock,
  MessagesRequest,
  MessagesStreamOptions,
  MessagesTool,
} from "@/types/anthropic";
import type { JsonMap } from "@/types/gateway";
import type { ChatStreamEncoder, ToolCallEvent } from "@/types/responses";

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function imagePart(source: JsonMap | null): JsonMap | null {
  if (source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source?.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

function documentPart(block: JsonMap): JsonMap | null {
  const source = asRecord(block.source);
  if (source?.type === "text") return typeof source.data === "string" && source.data ? { type: "text", text: source.data } : null;
  if (source?.type !== "base64" || typeof source.media_type !== "string" || typeof source.data !== "string") return null;
  return {
    type: "file",
    file: {
      filename: typeof block.title === "string" && block.title ? block.title : "document.pdf",
      file_data: `data:${source.media_type};base64,${source.data}`,
    },
  };
}

function blockParts(block: JsonMap): JsonMap[] {
  if (block.type === "text") return typeof block.text === "string" && block.text ? [{ type: "text", text: block.text }] : [];
  if (block.type === "image") {
    const part = imagePart(asRecord(block.source));
    return part ? [part] : [];
  }
  if (block.type === "document") {
    const part = documentPart(block);
    return part ? [part] : [];
  }
  return [];
}

function sourceIssue(block: JsonMap, where: string): string | null {
  const source = asRecord(block.source);
  const type = typeof source?.type === "string" ? source.type : "";
  if (block.type === "image" && type !== "base64" && type !== "url") {
    return `${where}: image source "${type}" requires an Anthropic deployment`;
  }
  if (block.type === "document" && type !== "base64" && type !== "text") {
    return `${where}: document source "${type}" requires an Anthropic deployment`;
  }
  return null;
}

export function chatIncompatibility(request: MessagesRequest): string | null {
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (tool.type && tool.type !== "custom") {
      return `tools.${index}.type: tool type "${tool.type}" requires an Anthropic deployment`;
    }
  }
  const supported = new Set(["text", "image", "document", "tool_use", "tool_result", "thinking", "redacted_thinking"]);
  for (const [m, message] of request.messages.entries()) {
    if (typeof message.content === "string") continue;
    for (const [b, raw] of message.content.entries()) {
      const block = raw as JsonMap;
      const where = `messages.${m}.content.${b}`;
      if (!supported.has(String(block.type))) {
        return `${where}.type: content block "${String(block.type)}" requires an Anthropic deployment`;
      }
      const issue = sourceIssue(block, where);
      if (issue) return issue;
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const [i, inner] of block.content.entries()) {
          const rec = asRecord(inner);
          if (!rec) continue;
          if (rec.type !== "text" && rec.type !== "image" && rec.type !== "document") {
            return `${where}.content.${i}.type: content block "${String(rec.type)}" requires an Anthropic deployment`;
          }
          const nested = sourceIssue(rec, `${where}.content.${i}`);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

function reasoningEffort(request: MessagesRequest): string | null {
  const effort = request.output_config?.effort;
  const thinking = request.thinking;
  if (thinking?.type === "disabled") return null;
  if (typeof effort === "string" && effort) return effort;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
    if (thinking.budget_tokens < 2048) return "low";
    if (thinking.budget_tokens < 8192) return "medium";
    return "high";
  }
  return null;
}

function simplify(parts: JsonMap[]): string | JsonMap[] {
  if (parts.length === 1 && parts[0]?.type === "text") return String(parts[0].text);
  return parts;
}

function userMessages(blocks: MessagesContentBlock[]): JsonMap[] {
  const out: JsonMap[] = [];
  const carried: JsonMap[] = [];
  const parts: JsonMap[] = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      const content = block.content ?? "";
      const texts: string[] = [];
      if (typeof content === "string") texts.push(content);
      else {
        for (const inner of content) {
          const rec = inner as JsonMap;
          if (rec.type === "text" && typeof rec.text === "string") texts.push(rec.text);
          else carried.push(...blockParts(rec));
        }
      }
      out.push({ role: "tool", tool_call_id: block.tool_use_id, content: texts.join("\n") });
      continue;
    }
    parts.push(...blockParts(block as JsonMap));
  }
  const rest = [...carried, ...parts];
  if (rest.length) out.push({ role: "user", content: simplify(rest) });
  return out;
}

function assistantMessage(blocks: MessagesContentBlock[]): JsonMap | null {
  let text = "";
  const toolCalls: JsonMap[] = [];
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(asRecord(block.input) ?? {}) },
      });
    }
  }
  if (!text && !toolCalls.length) return null;
  const message: JsonMap = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

function chatTool(tool: MessagesTool): JsonMap {
  const fn: JsonMap = {
    name: tool.name ?? "",
    parameters: tool.input_schema ?? { type: "object", properties: {} },
  };
  if (tool.description) fn.description = tool.description;
  if (tool.strict === true) fn.strict = true;
  return { type: "function", function: fn };
}

function chatToolChoice(choice: MessagesRequest["tool_choice"]): unknown {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return { type: "function", function: { name: choice.name } };
}

export function messagesToChat(request: MessagesRequest): JsonMap {
  const messages: JsonMap[] = [];
  const system =
    typeof request.system === "string"
      ? request.system
      : (request.system ?? []).map((block) => block.text).filter(Boolean).join("\n");
  if (system) messages.push({ role: "system", content: system });
  for (const message of request.messages) {
    if (message.role === "system") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const converted = assistantMessage(message.content);
      if (converted) messages.push(converted);
      continue;
    }
    messages.push(...userMessages(message.content));
  }
  const body: JsonMap = { model: request.model, messages };
  if (typeof request.max_tokens === "number" && request.max_tokens > 0) body.max_tokens = request.max_tokens;
  const effort = reasoningEffort(request);
  if (effort) body.reasoning_effort = effort;
  const format = request.output_config?.format;
  if (format?.type === "json_schema" && format.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: format.schema, strict: true },
    };
  }
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (request.stop_sequences?.length) body.stop = request.stop_sequences;
  if (request.metadata?.user_id) body.user = request.metadata.user_id;
  if (request.service_tier) body.service_tier = request.service_tier;
  if (request.tools?.length) {
    body.tools = request.tools.map(chatTool);
    const choice = chatToolChoice(request.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
    if (request.tool_choice?.type !== "none" && asRecord(request.tool_choice)?.disable_parallel_tool_use === true) {
      body.parallel_tool_calls = false;
    }
  }
  if (request.stream === true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function anthropicUsageFromChat(usage: unknown): AnthropicUsage {
  const rec = asRecord(usage);
  const prompt = count(rec?.prompt_tokens ?? rec?.input_tokens);
  const read = count(
    rec?.cache_read_input_tokens ??
      asRecord(rec?.prompt_tokens_details)?.cached_tokens ??
      asRecord(rec?.input_tokens_details)?.cached_tokens,
  );
  const created = count(rec?.cache_creation_input_tokens);
  return {
    input_tokens: Math.max(0, prompt - read - created),
    output_tokens: count(rec?.completion_tokens ?? rec?.output_tokens),
    cache_creation_input_tokens: created,
    cache_read_input_tokens: read,
  };
}

function stopReasonFromFinish(finish: unknown, hasTools: boolean, stopSequence: string | null): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "content_filter") return "refusal";
  if (hasTools) return "tool_use";
  if (stopSequence) return "stop_sequence";
  return "end_turn";
}

export function chatToMessage(chat: JsonMap, model: string): JsonMap {
  const choice = asRecord(Array.isArray(chat.choices) ? chat.choices[0] : null);
  const message = asRecord(choice?.message);
  const content: JsonMap[] = [];
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  const text = stringifyContent(message?.content);
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || typeof fn?.name !== "string") continue;
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `toolu_${newId()}`,
      name: fn.name,
      input: parseToolInput(fn.arguments),
    });
  }
  const hasTools = content.some((block) => block.type === "tool_use");
  if (!content.some((block) => block.type !== "thinking")) content.push({ type: "text", text: "" });
  const matched = choice?.finish_reason === "stop" && typeof choice.stop_reason === "string" ? choice.stop_reason : null;
  const stopReason = stopReasonFromFinish(choice?.finish_reason, hasTools, matched);
  return {
    id: `msg_${newId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: stopReason === "stop_sequence" ? matched : null,
    usage: anthropicUsageFromChat(chat.usage),
  };
}

export function anthropicPassthroughHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const version = headers.get("anthropic-version")?.trim();
  if (version) out["anthropic-version"] = version;
  const beta = headers.get("anthropic-beta")?.trim();
  if (beta) out["anthropic-beta"] = beta;
  return out;
}

export function apiKeyRequest(req: Request): Request {
  if (req.headers.get("authorization")) return req;
  const key = req.headers.get("x-api-key")?.trim();
  if (!key) return req;
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${key}`);
  return new Request(req.url, { headers });
}

export class MessagesStreamEncoder implements ChatStreamEncoder {
  private id = `msg_${newId()}`;
  private index = -1;
  private open: "text" | "tool_use" | "thinking" | null = null;
  private slots = new Map<number, number>();
  private deltas = new ToolCallDeltas();
  private hasTools = false;
  private reason: unknown = null;
  private matched: string | null = null;
  private usage: unknown = null;
  private done = false;

  constructor(
    private model: string,
    private options: MessagesStreamOptions = {},
  ) {}

  start(): string[] {
    return [
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.options.inputTokens ?? 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ];
  }

  private close(): string[] {
    if (this.open === null) return [];
    const out: string[] = [];
    if (this.open === "thinking") {
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "signature_delta", signature: "" },
        }),
      );
    }
    this.open = null;
    out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: this.index }));
    return out;
  }

  private thinking(delta: string): string[] {
    const out: string[] = [];
    if (this.open !== "thinking") {
      out.push(...this.close());
      this.index += 1;
      this.open = "thinking";
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
    }
    out.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "thinking_delta", thinking: delta },
      }),
    );
    return out;
  }

  private text(delta: string): string[] {
    const out: string[] = [];
    if (this.open !== "text") {
      out.push(...this.close());
      this.index += 1;
      this.open = "text";
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "text", text: "" },
        }),
      );
    }
    out.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text: delta },
      }),
    );
    return out;
  }

  private tool(event: ToolCallEvent): string[] {
    if (event.type === "start") {
      const out = this.close();
      this.index += 1;
      this.open = "tool_use";
      this.hasTools = true;
      this.slots.set(event.slot, this.index);
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
        }),
      );
      return out;
    }
    const index = this.slots.get(event.slot);
    if (index === undefined) return [];
    return [
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: event.delta },
      }),
    ];
  }

  push(chunk: JsonMap): string[] {
    if (this.done) return [];
    const out: string[] = [];
    if (asRecord(chunk.usage)) this.usage = chunk.usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = asRecord(choices.find((c) => Number(asRecord(c)?.index ?? 0) === 0));
    if (!choice) return out;
    const delta = asRecord(choice.delta);
    const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
    if (reasoning) out.push(...this.thinking(reasoning));
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) out.push(...this.text(text));
    for (const event of this.deltas.push(delta?.tool_calls)) out.push(...this.tool(event));
    if (choice.finish_reason) this.reason = choice.finish_reason;
    if (typeof choice.stop_reason === "string") this.matched = choice.stop_reason;
    return out;
  }

  finish(): string[] {
    if (this.done) return [];
    this.done = true;
    const out: string[] = [];
    for (const event of this.deltas.flush()) out.push(...this.tool(event));
    out.push(...this.close());
    const matched = this.reason === "stop" ? this.matched : null;
    const stopReason = stopReasonFromFinish(this.reason, this.hasTools, matched);
    const usage = anthropicUsageFromChat(this.usage);
    out.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: stopReason === "stop_sequence" ? matched : null,
        },
        usage: {
          input_tokens: this.usage ? usage.input_tokens : (this.options.inputTokens ?? 0),
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
      }),
      sseEvent("message_stop", { type: "message_stop" }),
    );
    return out;
  }

  fail(message: string): string[] {
    if (this.done) return [];
    this.done = true;
    return [sseEvent("error", anthropicErrorBody(500, message))];
  }
}
