import { asRecord, newId, stringifyContent } from "@/lib/gateway/core";
import { isCodexSignature } from "@/lib/gateway/protocols/reasoning-signature";
import type { JsonMap } from "@/types/gateway";
import type { ResponsesInputItem, ResponsesRequest, StoredResponse } from "@/types/responses";

const RESPONSE_PREFIX = "resp_";
const THINKING_PREFIX = "llmhub.thinking.v1.";
const ENCRYPTED_INCLUDE = "reasoning.encrypted_content";

export function responseId(objectId: string): string {
  return objectId.startsWith(RESPONSE_PREFIX) ? objectId : `${RESPONSE_PREFIX}${objectId}`;
}

export function storedObjectId(id: string): string {
  return id.startsWith(RESPONSE_PREFIX) ? id.slice(RESPONSE_PREFIX.length) : id;
}

function partsText(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const rec = asRecord(part);
      if (typeof rec?.text === "string") return rec.text;
      if (typeof rec?.refusal === "string") return rec.refusal;
      return "";
    })
    .join("");
}

function userContent(content: unknown): string | JsonMap[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: JsonMap[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "input_image" && typeof part.image_url === "string") {
      const image: JsonMap = { url: part.image_url };
      if (typeof part.detail === "string") image.detail = part.detail;
      parts.push({ type: "image_url", image_url: image });
    } else if (part.type === "input_file" && typeof part.file_data === "string") {
      const file: JsonMap = { file_data: part.file_data };
      if (typeof part.filename === "string") file.filename = part.filename;
      parts.push({ type: "file", file });
    } else {
      const text = partsText([part]);
      if (text) parts.push({ type: "text", text });
    }
  }
  if (parts.length === 1 && parts[0]?.type === "text") return String(parts[0].text);
  return parts;
}

export function encodeThinking(blocks: JsonMap[]): string {
  return `${THINKING_PREFIX}${Buffer.from(JSON.stringify(blocks)).toString("base64url")}`;
}

export function decodeThinking(value: unknown): JsonMap[] {
  if (typeof value !== "string" || !value.startsWith(THINKING_PREFIX)) return [];
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(THINKING_PREFIX.length), "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is JsonMap => asRecord(item) !== null) : [];
  } catch {
    return [];
  }
}

function reasoningThinking(item: JsonMap): JsonMap[] {
  const decoded = decodeThinking(item.encrypted_content);
  if (decoded.length || !isCodexSignature(item.encrypted_content)) return decoded;
  const summary = (Array.isArray(item.summary) ? item.summary : [])
    .map((part) => asRecord(part)?.text)
    .filter((text): text is string => typeof text === "string" && text !== "")
    .join("\n\n");
  return [{ type: "thinking", thinking: summary, signature: item.encrypted_content }];
}

function attachThinking(message: JsonMap, pending: JsonMap[]): void {
  if (!pending.length) return;
  const existing = Array.isArray(message.thinking_blocks) ? (message.thinking_blocks as JsonMap[]) : [];
  message.thinking_blocks = [...existing, ...pending.splice(0)];
}

function responsesInputToMessages(input: string | ResponsesInputItem[] | null | undefined): JsonMap[] {
  if (typeof input === "string") return input ? [{ role: "user", content: input }] : [];
  const out: JsonMap[] = [];
  const pending: JsonMap[] = [];
  for (const item of input ?? []) {
    if (item.type === "reasoning") {
      pending.push(...reasoningThinking(item));
      continue;
    }
    if (item.type === "message") {
      if (item.role === "assistant") {
        const message: JsonMap = { role: "assistant", content: partsText(item.content) };
        attachThinking(message, pending);
        out.push(message);
      } else if (item.role === "system" || item.role === "developer") {
        out.push({ role: "system", content: partsText(item.content) });
      } else {
        out.push({ role: "user", content: userContent(item.content) });
      }
      continue;
    }
    if (item.type === "function_call") {
      const call = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      };
      const last = out.at(-1);
      if (last?.role === "assistant") {
        last.tool_calls = [...(Array.isArray(last.tool_calls) ? last.tool_calls : []), call];
        if (last.content === "") last.content = null;
        attachThinking(last, pending);
      } else {
        const message: JsonMap = { role: "assistant", content: null, tool_calls: [call] };
        attachThinking(message, pending);
        out.push(message);
      }
      continue;
    }
    if (item.type === "function_call_output") {
      out.push({ role: "tool", tool_call_id: item.call_id, content: partsText(item.output) });
    }
  }
  return out;
}

function chatToolChoice(choice: ResponsesRequest["tool_choice"]): unknown {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

export function responsesToChat(
  request: ResponsesRequest,
  history: JsonMap[],
): { body: JsonMap; conversation: JsonMap[] } {
  const conversation = [...history, ...responsesInputToMessages(request.input)];
  const messages = request.instructions
    ? [{ role: "system", content: request.instructions }, ...conversation]
    : conversation;
  const body: JsonMap = { model: request.model, messages };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => {
      const fn: JsonMap = { name: tool.name };
      if (tool.description) fn.description = tool.description;
      if (tool.parameters) fn.parameters = tool.parameters;
      if (typeof tool.strict === "boolean") fn.strict = tool.strict;
      return { type: "function", function: fn };
    });
    const choice = chatToolChoice(request.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
    if (typeof request.parallel_tool_calls === "boolean") {
      body.parallel_tool_calls = request.parallel_tool_calls;
    }
  }
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (typeof request.max_output_tokens === "number") body.max_tokens = request.max_output_tokens;
  if (request.user) body.user = request.user;
  if (request.service_tier) body.service_tier = request.service_tier;
  if (request.access_programs?.cyber) body.access_programs = { cyber: request.access_programs.cyber };
  if (request.reasoning?.effort) body.reasoning_effort = request.reasoning.effort;
  if (request.text?.verbosity) body.verbosity = request.text.verbosity;
  if (request.prompt_cache_key) body.prompt_cache_key = request.prompt_cache_key;
  if (request.safety_identifier) body.safety_identifier = request.safety_identifier;
  const format = request.text?.format;
  if (format?.type === "json_object") body.response_format = { type: "json_object" };
  if (format?.type === "json_schema") {
    const schema: JsonMap = { name: format.name, schema: format.schema };
    if (format.description) schema.description = format.description;
    if (typeof format.strict === "boolean") schema.strict = format.strict;
    body.response_format = { type: "json_schema", json_schema: schema };
  }
  if (request.stream === true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return { body, conversation };
}

export function responseSkeleton(request: ResponsesRequest, id: string, createdAt: number): JsonMap {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model,
    output: [],
    output_text: "",
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: { effort: request.reasoning?.effort ?? null, summary: request.reasoning?.summary ?? null },
    service_tier: request.service_tier ?? null,
    store: request.store !== false,
    temperature: request.temperature ?? 1,
    text: { format: request.text?.format ?? { type: "text" }, verbosity: request.text?.verbosity ?? "medium" },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? 1,
    truncation: "disabled",
    usage: null,
    user: request.user ?? null,
    metadata: request.metadata ?? {},
  };
}

export function responsesUsage(usage: unknown): JsonMap {
  const rec = asRecord(usage);
  const input = Number(rec?.prompt_tokens ?? rec?.input_tokens ?? 0) || 0;
  const output = Number(rec?.completion_tokens ?? rec?.output_tokens ?? 0) || 0;
  const cached =
    Number(
      asRecord(rec?.prompt_tokens_details)?.cached_tokens ?? rec?.cache_read_input_tokens ?? 0,
    ) || 0;
  const reasoning = Number(asRecord(rec?.completion_tokens_details)?.reasoning_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

export function incompleteReason(finish: unknown): string | null {
  if (finish === "length") return "max_output_tokens";
  if (finish === "content_filter") return "content_filter";
  return null;
}

export function outputText(output: JsonMap[]): string {
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const rec = asRecord(part);
      if (rec?.type === "output_text" && typeof rec.text === "string") text += rec.text;
    }
  }
  return text;
}

export function textPart(text: string): JsonMap {
  return { type: "output_text", text, annotations: [] };
}

function reasoningItem(text: string, blocks: JsonMap[]): JsonMap {
  const item: JsonMap = {
    id: `rs_${newId()}`,
    type: "reasoning",
    summary: text ? [{ type: "summary_text", text }] : [],
  };
  if (blocks.length) item.encrypted_content = encodeThinking(blocks);
  return item;
}

function hidesEncrypted(include: string[] | null | undefined): boolean {
  return !include?.includes(ENCRYPTED_INCLUDE);
}

export function visibleItem(item: JsonMap, include: string[] | null | undefined): JsonMap {
  if (item.type !== "reasoning" || !("encrypted_content" in item) || !hidesEncrypted(include)) return item;
  const copy = { ...item };
  delete copy.encrypted_content;
  return copy;
}

export function visibleResponse(response: JsonMap, include: string[] | null | undefined): JsonMap {
  if (!Array.isArray(response.output) || !hidesEncrypted(include)) return response;
  return {
    ...response,
    output: response.output.map((item) => {
      const rec = asRecord(item);
      return rec ? visibleItem(rec, include) : item;
    }),
  };
}

export function chatToResponse(chat: JsonMap, skeleton: JsonMap): JsonMap {
  const choice = asRecord(Array.isArray(chat.choices) ? chat.choices[0] : null);
  const message = asRecord(choice?.message);
  const incomplete = incompleteReason(choice?.finish_reason);
  const output: JsonMap[] = [];
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  const blocks = Array.isArray(message?.thinking_blocks)
    ? message.thinking_blocks.filter((item): item is JsonMap => asRecord(item) !== null)
    : [];
  if (reasoning || blocks.length) output.push(reasoningItem(reasoning, blocks));
  const text = stringifyContent(message?.content);
  const content: JsonMap[] = [];
  if (text) content.push(textPart(text));
  if (typeof message?.refusal === "string" && message.refusal) {
    content.push({ type: "refusal", refusal: message.refusal });
  }
  if (content.length) {
    output.push({
      id: `msg_${newId()}`,
      type: "message",
      status: incomplete ? "incomplete" : "completed",
      role: "assistant",
      content,
    });
  }
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || typeof fn?.name !== "string") continue;
    output.push({
      id: `fc_${newId()}`,
      type: "function_call",
      status: "completed",
      call_id: typeof call.id === "string" && call.id ? call.id : `call_${newId()}`,
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return {
    ...skeleton,
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete ? { reason: incomplete } : null,
    output,
    output_text: outputText(output),
    usage: responsesUsage(chat.usage),
  };
}

export function responseMessages(response: JsonMap): JsonMap[] {
  const output = Array.isArray(response.output) ? response.output : [];
  let text = "";
  const toolCalls: JsonMap[] = [];
  const thinking: JsonMap[] = [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (!item) continue;
    if (item.type === "reasoning") thinking.push(...decodeThinking(item.encrypted_content));
    if (item.type === "message") text += partsText(item.content);
    if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call_${newId()}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
    }
  }
  if (!text && !toolCalls.length) return [];
  const message: JsonMap = { role: "assistant", content: text || null };
  if (thinking.length) message.thinking_blocks = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return [message];
}

export function storedResponse(objectId: string, payload: unknown): StoredResponse {
  const rec = asRecord(payload) ?? {};
  if (rec.object === "response") {
    return { response: { ...rec, id: responseId(objectId) }, messages: responseMessages(rec), input: [] };
  }
  const response = asRecord(rec.response) ?? {};
  const messages = Array.isArray(rec.messages)
    ? rec.messages.filter((item): item is JsonMap => asRecord(item) !== null)
    : responseMessages(response);
  const input = Array.isArray(rec.input) ? rec.input.filter((item): item is JsonMap => asRecord(item) !== null) : [];
  return { response: { ...response, id: responseId(objectId) }, messages, input };
}

export function inputItems(input: string | ResponsesInputItem[] | null | undefined): JsonMap[] {
  const items: JsonMap[] =
    typeof input === "string"
      ? input
        ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
        : []
      : (input ?? []).map((item) => ({ ...(item as JsonMap) }));
  return items.map((item) => {
    if (typeof item.id === "string" && item.id) return item;
    const prefix = item.type === "message" ? "msg" : item.type === "reasoning" ? "rs" : "item";
    const withId: JsonMap = { id: `${prefix}_${newId()}`, ...item };
    if (item.type === "message" && typeof item.content === "string") {
      withId.content = [
        { type: item.role === "assistant" ? "output_text" : "input_text", text: item.content },
      ];
    }
    return withId;
  });
}

export function pageItems(
  items: JsonMap[],
  query: { after?: string | null; limit?: string | null; order?: string | null },
): JsonMap {
  const ordered = query.order === "asc" ? [...items] : [...items].reverse();
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const start = query.after ? ordered.findIndex((item) => item.id === query.after) + 1 : 0;
  const data = ordered.slice(start, start + limit);
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: start + limit < ordered.length,
  };
}

const RESPONSES_COUNT_KEYS = [
  "model",
  "input",
  "instructions",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "truncation",
];

function pick(source: JsonMap, keys: string[]): JsonMap {
  const out: JsonMap = {};
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out;
}

export function responsesCountBody(clean: JsonMap, request: ResponsesRequest, history: JsonMap[]): JsonMap {
  const body = pick(clean, RESPONSES_COUNT_KEYS);
  if (!history.length) return body;
  const current =
    typeof request.input === "string"
      ? request.input
        ? [{ type: "message", role: "user", content: request.input }]
        : []
      : Array.isArray(clean.input)
        ? clean.input
        : [];
  return { ...body, input: [...chatMessagesToItems(history), ...current] };
}

export function chatToResponsesCountBody(chat: JsonMap, model: string): JsonMap {
  const body: JsonMap = {
    model,
    input: chatMessagesToItems(Array.isArray(chat.messages) ? chat.messages.filter((m): m is JsonMap => asRecord(m) !== null) : []),
  };
  const tools = Array.isArray(chat.tools) ? chat.tools : [];
  if (tools.length) {
    body.tools = tools.map((raw) => {
      const fn = asRecord(asRecord(raw)?.function) ?? {};
      const tool: JsonMap = { type: "function", name: fn.name, parameters: fn.parameters ?? { type: "object" } };
      if (fn.description) tool.description = fn.description;
      if (typeof fn.strict === "boolean") tool.strict = fn.strict;
      return tool;
    });
  }
  if (typeof chat.reasoning_effort === "string") body.reasoning = { effort: chat.reasoning_effort };
  return body;
}

export function chatMessagesToItems(messages: JsonMap[]): JsonMap[] {
  const items: JsonMap[] = [];
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        output: stringifyContent(message.content),
      });
      continue;
    }
    if (role === "assistant") {
      const text = stringifyContent(message.content);
      if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const raw of calls) {
        const call = asRecord(raw);
        const fn = asRecord(call?.function);
        if (!call || typeof fn?.name !== "string") continue;
        items.push({
          type: "function_call",
          call_id: typeof call.id === "string" ? call.id : "",
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        });
      }
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      items.push({ type: "message", role, content });
      continue;
    }
    const parts: JsonMap[] = [];
    for (const raw of Array.isArray(content) ? content : []) {
      const part = asRecord(raw);
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push({ type: "input_text", text: part.text });
      const image = asRecord(part.image_url);
      if (part.type === "image_url" && typeof image?.url === "string") {
        parts.push({ type: "input_image", image_url: image.url, detail: image.detail ?? "auto" });
      }
      const file = asRecord(part.file);
      if (part.type === "file" && file) parts.push({ type: "input_file", ...file });
    }
    items.push({ type: "message", role, content: parts });
  }
  return items;
}
