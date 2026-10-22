import { parseToolInput } from "@/lib/gateway/protocols/anthropic";
import { asRecord, newId, stringifyContent } from "@/lib/gateway/core";
import { tokenCount } from "@/lib/gateway/billing/tokens";
import { anthropicErrorBody } from "@/lib/gateway/errors";
import { sseEvent } from "@/lib/gateway/protocols/sse";
import { ToolCallDeltas } from "@/lib/gateway/protocols/chat-stream";
import { VALIDATED_BLOCK_TYPES } from "@/schemas/anthropic";
import type {
  AnthropicUsage,
  MessagesContentBlock,
  MessagesRequest,
  MessagesRequestBlock,
  MessagesStreamOptions,
  MessagesTool,
} from "@/types/anthropic";
import type { JsonMap } from "@/types/gateway";
import type { ChatStreamEncoder, ToolCallEvent } from "@/types/responses";

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

const WEB_SEARCH_TOOL = /^web_search_\d{8}$/;
const WEB_SEARCH_BLOCKS = ["server_tool_use", "web_search_tool_result"];

export type ChatFallbackOptions = { webSearch?: boolean };

function isWebSearchTool(tool: MessagesTool): boolean {
  return typeof tool.type === "string" && WEB_SEARCH_TOOL.test(tool.type);
}

export function chatIncompatibility(request: MessagesRequest, options: ChatFallbackOptions = {}): string | null {
  for (const [index, tool] of (request.tools ?? []).entries()) {
    if (options.webSearch && isWebSearchTool(tool)) continue;
    if (tool.type && tool.type !== "custom") {
      return `tools.${index}.type: tool type "${tool.type}" requires an Anthropic deployment`;
    }
  }
  const supported = new Set(VALIDATED_BLOCK_TYPES);
  if (options.webSearch) for (const type of WEB_SEARCH_BLOCKS) supported.add(type);
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

function validatedBlocks(blocks: MessagesRequestBlock[]): MessagesContentBlock[] {
  return blocks.filter((block): block is MessagesContentBlock => VALIDATED_BLOCK_TYPES.has(block.type));
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
  const thinking: JsonMap[] = [];
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
    if (block.type === "thinking" && typeof block.signature === "string" && block.signature) {
      thinking.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      thinking.push({ type: "redacted_thinking", data: block.data });
    }
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
  if (thinking.length) message.thinking_blocks = thinking;
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

const SESSION_SUFFIX = /_session_([0-9a-f-]{8,})$/i;

export function claudeCodeSession(userId: unknown): string {
  if (typeof userId !== "string" || !userId) return "";
  const suffix = SESSION_SUFFIX.exec(userId)?.[1];
  if (suffix) return suffix;
  if (userId.startsWith("{")) {
    try {
      const parsed = asRecord(JSON.parse(userId));
      if (typeof parsed?.session_id === "string" && parsed.session_id) return parsed.session_id;
    } catch {
      return "";
    }
  }
  return "";
}

export function claudeCodeSessionKey(session: string): string {
  return session ? `claude-code-${session}` : "";
}

export function claudeCodeCacheKey(metadata: unknown): string {
  return claudeCodeSessionKey(claudeCodeSession(asRecord(metadata)?.user_id));
}

function webSearchOptions(tool: MessagesTool, choice: MessagesRequest["tool_choice"]): JsonMap {
  const rec = asRecord(tool) ?? {};
  const options: JsonMap = {};
  if (Array.isArray(rec.allowed_domains) && rec.allowed_domains.length) options.allowed_domains = rec.allowed_domains;
  if (asRecord(rec.user_location)) options.user_location = rec.user_location;
  if (choice?.type === "tool" && choice.name === tool.name) options.forced = true;
  return options;
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
          : validatedBlocks(message.content)
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const converted = assistantMessage(validatedBlocks(message.content));
      if (converted) messages.push(converted);
      continue;
    }
    messages.push(...userMessages(validatedBlocks(message.content)));
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
  const cacheKey = claudeCodeCacheKey(request.metadata);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  if (request.service_tier) body.service_tier = request.service_tier;
  if (request.speed) body.speed = request.speed;
  const webTool = (request.tools ?? []).find(isWebSearchTool);
  const clientTools = (request.tools ?? []).filter((tool) => !isWebSearchTool(tool));
  if (webTool) body.web_search = webSearchOptions(webTool, request.tool_choice);
  if (clientTools.length) {
    body.tools = clientTools.map(chatTool);
    const forcedSearch = asRecord(body.web_search)?.forced === true;
    const choice = forcedSearch ? undefined : chatToolChoice(request.tool_choice);
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
  const prompt = tokenCount(rec?.prompt_tokens ?? rec?.input_tokens);
  const read = tokenCount(
    rec?.cache_read_input_tokens ??
      asRecord(rec?.prompt_tokens_details)?.cached_tokens ??
      asRecord(rec?.input_tokens_details)?.cached_tokens,
  );
  const created = tokenCount(rec?.cache_creation_input_tokens);
  return {
    input_tokens: Math.max(0, prompt - read - created),
    output_tokens: tokenCount(rec?.completion_tokens ?? rec?.output_tokens),
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

function webSearchBlocks(call: JsonMap): JsonMap[] {
  const id = `srvtoolu_${typeof call.id === "string" && call.id ? call.id : newId()}`;
  const sources = Array.isArray(call.sources) ? call.sources : [];
  const results = sources
    .map(asRecord)
    .filter((source): source is JsonMap => typeof source?.url === "string" && source.url !== "")
    .map((source) => ({
      type: "web_search_result",
      url: source.url,
      title: typeof source.title === "string" && source.title ? source.title : source.url,
      encrypted_content: "",
      page_age: null,
    }));
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query: typeof call.query === "string" ? call.query : "" } },
    { type: "web_search_tool_result", tool_use_id: id, content: results },
  ];
}

function webSearchCalls(value: unknown): JsonMap[] {
  return (Array.isArray(value) ? value : []).map(asRecord).filter((call): call is JsonMap => call !== null);
}

function signedThinking(value: unknown): JsonMap[] {
  const out: JsonMap[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const block = asRecord(raw);
    if (block?.type === "thinking" && typeof block.signature === "string" && block.signature) {
      out.push({ type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", signature: block.signature });
    } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
      out.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return out;
}

export function chatToMessage(chat: JsonMap, model: string): JsonMap {
  const choice = asRecord(Array.isArray(chat.choices) ? chat.choices[0] : null);
  const message = asRecord(choice?.message);
  const content: JsonMap[] = [];
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  const signed = signedThinking(message?.thinking_blocks);
  if (signed.length) content.push(...signed);
  else if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  const searches = webSearchCalls(message?.web_search_calls);
  for (const call of searches) content.push(...webSearchBlocks(call));
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
    usage: searches.length
      ? { ...anthropicUsageFromChat(chat.usage), server_tool_use: { web_search_requests: searches.length } }
      : anthropicUsageFromChat(chat.usage),
  };
}

const UNFORWARDED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "accept-encoding",
  "origin",
  "referer",
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
]);
const UNFORWARDED_HEADER_PREFIXES = ["x-forwarded-", "x-hub-", "x-llmhub-", "cf-", "sec-"];

export function anthropicPassthroughHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (UNFORWARDED_HEADERS.has(name)) return;
    if (UNFORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) return;
    const trimmed = value.trim();
    if (trimmed) out[name] = trimmed;
  });
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
  private signature = "";
  private searches = 0;

  constructor(
    private model: string,
    private options: MessagesStreamOptions = {},
  ) {}

  keepAlive(): string {
    return sseEvent("ping", { type: "ping" });
  }

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
          delta: { type: "signature_delta", signature: this.signature },
        }),
      );
      this.signature = "";
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
    if (delta) {
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "thinking_delta", thinking: delta },
        }),
      );
    }
    return out;
  }

  private signed(blocks: unknown): string[] {
    const out: string[] = [];
    for (const block of signedThinking(blocks)) {
      if (block.type === "redacted_thinking") {
        out.push(...this.close());
        this.index += 1;
        out.push(
          sseEvent("content_block_start", { type: "content_block_start", index: this.index, content_block: block }),
          sseEvent("content_block_stop", { type: "content_block_stop", index: this.index }),
        );
        continue;
      }
      if (this.open !== "thinking") out.push(...this.thinking(""));
      this.signature = String(block.signature);
      out.push(...this.close());
    }
    return out;
  }

  private webSearch(calls: unknown): string[] {
    const out: string[] = [];
    for (const call of webSearchCalls(calls)) {
      const [use, result] = webSearchBlocks(call);
      out.push(...this.close());
      this.index += 1;
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { ...use, input: {} },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(use!.input) },
        }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: this.index }),
      );
      this.index += 1;
      out.push(
        sseEvent("content_block_start", { type: "content_block_start", index: this.index, content_block: result }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: this.index }),
      );
      this.searches += 1;
    }
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
    out.push(...this.signed(delta?.thinking_blocks));
    out.push(...this.webSearch(delta?.web_search_calls));
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
          ...(this.searches ? { server_tool_use: { web_search_requests: this.searches } } : {}),
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
