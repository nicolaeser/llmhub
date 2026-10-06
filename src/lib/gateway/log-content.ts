import { isOpaqueText } from "@/lib/gateway/pii";
import type { JsonMap } from "@/types/gateway";
import type { LogPayload, TranscriptEntry } from "@/types/logs";

const STRING_LIMITS = [65_536, 8_192, 1_024];
const MAX_ITEMS = 1_000;
const MAX_DEPTH = 32;
const MAX_CHARS = 1_000_000;
const VECTOR_MIN = 64;

function record(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: unknown, limit: number, state: { truncated: boolean }, depth: number): unknown {
  if (typeof value === "string") {
    if (isOpaqueText(value)) return `[binary · ${value.length} chars]`;
    if (value.length <= limit) return value;
    state.truncated = true;
    return `${value.slice(0, limit)}… [+${value.length - limit} chars]`;
  }
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return "[…]";
  }
  if (Array.isArray(value)) {
    if (value.length >= VECTOR_MIN && value.every((item) => typeof item === "number")) {
      return `[vector · ${value.length} numbers]`;
    }
    const items = value.slice(0, MAX_ITEMS).map((item) => clip(item, limit, state, depth + 1));
    if (value.length > MAX_ITEMS) {
      state.truncated = true;
      items.push(`… [+${value.length - MAX_ITEMS} items]`);
    }
    return items;
  }
  const rec = record(value);
  if (rec) {
    const out: JsonMap = {};
    for (const [key, item] of Object.entries(rec)) {
      if (item !== undefined) out[key] = clip(item, limit, state, depth + 1);
    }
    return out;
  }
  return value;
}

export function logPayload(value: unknown): LogPayload | null {
  if (value === undefined || value === null) return null;
  for (const limit of STRING_LIMITS) {
    const state = { truncated: false };
    const out = clip(value, limit, state, 0);
    if ((JSON.stringify(out)?.length ?? 0) <= MAX_CHARS) return { value: out, truncated: state.truncated };
  }
  return { value: "[payload too large]", truncated: true };
}

type ChatSlot = {
  content: string;
  reasoning: string;
  tools: Map<number, { id: string; name: string; arguments: string }>;
};

export class ChatStreamTranscript {
  private slots = new Map<number, ChatSlot>();

  push(chunk: JsonMap): void {
    for (const raw of list(chunk.choices)) {
      const choice = record(raw);
      const delta = record(choice?.delta) ?? record(choice?.message);
      if (!choice || !delta) {
        if (choice && typeof choice.text === "string") this.slot(choice).content += choice.text;
        continue;
      }
      const slot = this.slot(choice);
      slot.content += textOf(delta.content);
      slot.reasoning += str(delta.reasoning_content);
      for (const rawCall of list(delta.tool_calls)) {
        const call = record(rawCall);
        if (!call) continue;
        const index = typeof call.index === "number" ? call.index : slot.tools.size;
        const tool = slot.tools.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = record(call.function);
        tool.id ||= str(call.id);
        tool.name ||= str(fn?.name);
        tool.arguments += str(fn?.arguments);
        slot.tools.set(index, tool);
      }
    }
  }

  result(): JsonMap | null {
    if (!this.slots.size) return null;
    const choices = [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, slot]) => ({
        index,
        message: {
          role: "assistant",
          content: slot.content,
          ...(slot.reasoning ? { reasoning_content: slot.reasoning } : {}),
          ...(slot.tools.size
            ? {
                tool_calls: [...slot.tools.values()].map((tool) => ({
                  id: tool.id,
                  type: "function",
                  function: { name: tool.name, arguments: tool.arguments },
                })),
              }
            : {}),
        },
      }));
    return { object: "chat.completion", choices };
  }

  private slot(choice: JsonMap): ChatSlot {
    const index = typeof choice.index === "number" ? choice.index : 0;
    const existing = this.slots.get(index);
    if (existing) return existing;
    const created: ChatSlot = { content: "", reasoning: "", tools: new Map() };
    this.slots.set(index, created);
    return created;
  }
}

export class MessagesStreamTranscript {
  private blocks = new Map<number, JsonMap>();

  push(event: JsonMap, type: string): void {
    const index = typeof event.index === "number" ? event.index : 0;
    if (type === "content_block_start") {
      const block = record(event.content_block);
      if (block) this.blocks.set(index, block.type === "tool_use" ? { ...block, input: "" } : { ...block });
      return;
    }
    if (type !== "content_block_delta") return;
    const delta = record(event.delta);
    const block = this.blocks.get(index) ?? { type: "text", text: "" };
    if (typeof delta?.text === "string") block.text = str(block.text) + delta.text;
    if (typeof delta?.thinking === "string") block.thinking = str(block.thinking) + delta.thinking;
    if (typeof delta?.partial_json === "string") block.input = str(block.input) + delta.partial_json;
    this.blocks.set(index, block);
  }

  result(): JsonMap | null {
    if (!this.blocks.size) return null;
    const content = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => {
        if (block.type !== "tool_use" || typeof block.input !== "string") return block;
        try {
          return { ...block, input: block.input ? JSON.parse(block.input) : {} };
        } catch {
          return block;
        }
      });
    return { type: "message", role: "assistant", content };
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content)
    .map((part) => {
      const rec = record(part);
      return typeof part === "string" ? part : str(rec?.text);
    })
    .join("");
}

function compact(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

const MEDIA_TYPES: Record<string, string> = {
  image: "image",
  image_url: "image",
  input_image: "image",
  file: "file",
  input_file: "file",
  document: "file",
  input_audio: "audio",
  audio: "audio",
};

function contentEntries(role: string, content: unknown): TranscriptEntry[] {
  if (typeof content === "string") return content ? [{ role, kind: "text", text: content }] : [];
  const out: TranscriptEntry[] = [];
  for (const raw of list(content)) {
    if (typeof raw === "string") {
      if (raw) out.push({ role, kind: "text", text: raw });
      continue;
    }
    const part = record(raw);
    if (!part) continue;
    const type = str(part.type);
    if (typeof part.text === "string" && (type === "" || type.endsWith("text"))) {
      if (part.text) out.push({ role, kind: "text", text: part.text });
    } else if (type === "thinking" || type === "reasoning") {
      const text = str(part.thinking) || textOf(part.summary);
      if (text) out.push({ role, kind: "reasoning", text });
    } else if (type === "tool_use" || type === "server_tool_use") {
      out.push({ role, kind: "tool_call", name: str(part.name), text: compact(part.input) });
    } else if (type === "tool_result") {
      out.push({ role, kind: "tool_result", text: typeof part.content === "string" ? part.content : textOf(part.content) });
    } else if (MEDIA_TYPES[type]) {
      out.push({ role, kind: "media", text: MEDIA_TYPES[type] });
    }
  }
  return out;
}

function messageEntries(raw: unknown): TranscriptEntry[] {
  const message = record(raw);
  if (!message) return typeof raw === "string" && raw ? [{ role: "user", kind: "text", text: raw }] : [];
  const type = str(message.type);
  if (type === "function_call") {
    return [{ role: "assistant", kind: "tool_call", name: str(message.name), text: compact(message.arguments) }];
  }
  if (type === "function_call_output") {
    return [{ role: "tool", kind: "tool_result", text: compact(message.output) }];
  }
  if (type === "reasoning") {
    const text = textOf(message.summary);
    return text ? [{ role: "assistant", kind: "reasoning", text }] : [];
  }
  const role = str(message.role) || "user";
  if (role === "tool") {
    return [{ role, kind: "tool_result", name: str(message.name), text: textOf(message.content) || compact(message.content) }];
  }
  const out: TranscriptEntry[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    out.push({ role, kind: "reasoning", text: message.reasoning_content });
  }
  out.push(...contentEntries(role, message.content));
  for (const rawCall of list(message.tool_calls)) {
    const call = record(rawCall);
    const fn = record(call?.function);
    if (fn) out.push({ role, kind: "tool_call", name: str(fn.name), text: compact(fn.arguments) });
  }
  return out;
}

function promptEntries(value: unknown): TranscriptEntry[] {
  if (typeof value === "string") return value ? [{ role: "user", kind: "text", text: value }] : [];
  return list(value).flatMap((item) => (typeof item === "string" && item ? [{ role: "user", kind: "text" as const, text: item }] : []));
}

export function requestTranscript(request: unknown): TranscriptEntry[] {
  const body = record(request);
  if (!body) return promptEntries(request);
  const out: TranscriptEntry[] = [];
  if (body.system !== undefined) out.push(...contentEntries("system", body.system));
  if (typeof body.instructions === "string" && body.instructions) {
    out.push({ role: "system", kind: "text", text: body.instructions });
  }
  for (const message of list(body.messages)) out.push(...messageEntries(message));
  if (Array.isArray(body.input)) {
    for (const item of body.input) out.push(...messageEntries(item));
  } else {
    out.push(...promptEntries(body.input));
  }
  out.push(...promptEntries(body.prompt));
  return out;
}

export function responseTranscript(response: unknown): TranscriptEntry[] {
  const body = record(response);
  if (!body) return promptEntries(response).map((entry) => ({ ...entry, role: "assistant" }));
  const out: TranscriptEntry[] = [];
  for (const raw of list(body.choices)) {
    const choice = record(raw);
    if (!choice) continue;
    if (typeof choice.text === "string") {
      if (choice.text) out.push({ role: "assistant", kind: "text", text: choice.text });
      continue;
    }
    out.push(...messageEntries({ role: "assistant", ...(record(choice.message) ?? {}) }));
  }
  if (body.type === "message" || (str(body.role) === "assistant" && Array.isArray(body.content))) {
    out.push(...contentEntries("assistant", body.content));
  }
  for (const item of list(body.output)) {
    const rec = record(item);
    if (rec && str(rec.type) === "message") out.push(...contentEntries(str(rec.role) || "assistant", rec.content));
    else out.push(...messageEntries(item).map((entry) => ({ ...entry, role: "assistant" })));
  }
  if (typeof body.text === "string" && body.text) out.push({ role: "assistant", kind: "text", text: body.text });
  for (const raw of list(body.data)) {
    const item = record(raw);
    if (item && (typeof item.b64_json === "string" || typeof item.url === "string")) {
      out.push({ role: "assistant", kind: "media", text: "image" });
    }
  }
  return out;
}
