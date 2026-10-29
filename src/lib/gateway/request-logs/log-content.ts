import { asArray, asRecord, asString } from "@/lib/gateway/core";
import { isOpaqueText } from "@/lib/gateway/safety/pii";
import type { JsonMap } from "@/types/gateway";
import type { LogPayload, TranscriptEntry } from "@/types/logs";

const STRING_LIMITS = [65_536, 8_192, 1_024];
const MAX_ITEMS = 1_000;
const MAX_DEPTH = 32;
const MAX_CHARS = 1_000_000;
const VECTOR_MIN = 64;

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
  const rec = asRecord(value);
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
    for (const raw of asArray(chunk.choices)) {
      const choice = asRecord(raw);
      const delta = asRecord(choice?.delta) ?? asRecord(choice?.message);
      if (!choice || !delta) {
        if (choice && typeof choice.text === "string") this.slot(choice).content += choice.text;
        continue;
      }
      const slot = this.slot(choice);
      slot.content += textOf(delta.content);
      slot.reasoning += asString(delta.reasoning_content);
      for (const rawCall of asArray(delta.tool_calls)) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const index = typeof call.index === "number" ? call.index : slot.tools.size;
        const tool = slot.tools.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = asRecord(call.function);
        tool.id ||= asString(call.id);
        tool.name ||= asString(fn?.name);
        tool.arguments += asString(fn?.arguments);
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
      const block = asRecord(event.content_block);
      if (block) this.blocks.set(index, block.type === "tool_use" ? { ...block, input: "" } : { ...block });
      return;
    }
    if (type !== "content_block_delta") return;
    const delta = asRecord(event.delta);
    const block = this.blocks.get(index) ?? { type: "text", text: "" };
    if (typeof delta?.text === "string") block.text = asString(block.text) + delta.text;
    if (typeof delta?.thinking === "string") block.thinking = asString(block.thinking) + delta.thinking;
    if (typeof delta?.partial_json === "string") block.input = asString(block.input) + delta.partial_json;
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
  return asArray(content)
    .map((part) => {
      const rec = asRecord(part);
      return typeof part === "string" ? part : asString(rec?.text);
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

const REMOTE_URL = /^https?:\/\//i;

function remoteUrl(value: unknown): string {
  const rec = asRecord(value);
  const text = typeof value === "string" ? value : asString(rec?.url);
  return REMOTE_URL.test(text) && text.length <= 2_048 ? text : "";
}

function mediaEntry(role: string, type: string, part: JsonMap): TranscriptEntry {
  const source = asRecord(part.source);
  const file = asRecord(part.file);
  const url = remoteUrl(part.image_url) || remoteUrl(part.url) || remoteUrl(source);
  const name = asString(part.filename) || asString(file?.filename) || asString(part.title) || asString(source?.media_type);
  return { role, kind: "media", text: MEDIA_TYPES[type]!, ...(name ? { name } : {}), ...(url ? { url } : {}) };
}

function contentEntries(role: string, content: unknown): TranscriptEntry[] {
  if (typeof content === "string") return content ? [{ role, kind: "text", text: content }] : [];
  const out: TranscriptEntry[] = [];
  for (const raw of asArray(content)) {
    if (typeof raw === "string") {
      if (raw) out.push({ role, kind: "text", text: raw });
      continue;
    }
    const part = asRecord(raw);
    if (!part) continue;
    const type = asString(part.type);
    if (typeof part.text === "string" && (type === "" || type.endsWith("text"))) {
      if (part.text) out.push({ role, kind: "text", text: part.text });
    } else if (type === "thinking" || type === "reasoning") {
      const text = asString(part.thinking) || textOf(part.summary);
      if (text) out.push({ role, kind: "reasoning", text });
    } else if (type === "tool_use" || type === "server_tool_use") {
      out.push({ role, kind: "tool_call", name: asString(part.name), text: compact(part.input) });
    } else if (type === "tool_result") {
      out.push({ role, kind: "tool_result", text: typeof part.content === "string" ? part.content : textOf(part.content) });
    } else if (MEDIA_TYPES[type]) {
      out.push(mediaEntry(role, type, part));
    }
  }
  return out;
}

function messageEntries(raw: unknown): TranscriptEntry[] {
  const message = asRecord(raw);
  if (!message) return typeof raw === "string" && raw ? [{ role: "user", kind: "text", text: raw }] : [];
  const type = asString(message.type);
  if (type === "function_call") {
    return [{ role: "assistant", kind: "tool_call", name: asString(message.name), text: compact(message.arguments) }];
  }
  if (type === "function_call_output") {
    return [{ role: "tool", kind: "tool_result", text: compact(message.output) }];
  }
  if (type === "reasoning") {
    const text = textOf(message.summary);
    return text ? [{ role: "assistant", kind: "reasoning", text }] : [];
  }
  const role = asString(message.role) || "user";
  if (role === "tool") {
    return [{ role, kind: "tool_result", name: asString(message.name), text: textOf(message.content) || compact(message.content) }];
  }
  const out: TranscriptEntry[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    out.push({ role, kind: "reasoning", text: message.reasoning_content });
  }
  out.push(...contentEntries(role, message.content));
  for (const rawCall of asArray(message.tool_calls)) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    if (fn) out.push({ role, kind: "tool_call", name: asString(fn.name), text: compact(fn.arguments) });
  }
  return out;
}

function promptEntries(value: unknown): TranscriptEntry[] {
  if (typeof value === "string") return value ? [{ role: "user", kind: "text", text: value }] : [];
  return asArray(value).flatMap((item) => (typeof item === "string" && item ? [{ role: "user", kind: "text" as const, text: item }] : []));
}

export function requestTranscript(request: unknown): TranscriptEntry[] {
  const body = asRecord(request);
  if (!body) return promptEntries(request);
  const out: TranscriptEntry[] = [];
  if (body.system !== undefined) out.push(...contentEntries("system", body.system));
  if (typeof body.instructions === "string" && body.instructions) {
    out.push({ role: "system", kind: "text", text: body.instructions });
  }
  for (const message of asArray(body.messages)) out.push(...messageEntries(message));
  if (Array.isArray(body.input)) {
    for (const item of body.input) out.push(...messageEntries(item));
  } else {
    out.push(...promptEntries(body.input));
  }
  out.push(...promptEntries(body.prompt));
  return out;
}

export function responseTranscript(response: unknown): TranscriptEntry[] {
  const body = asRecord(response);
  if (!body) return promptEntries(response).map((entry) => ({ ...entry, role: "assistant" }));
  const out: TranscriptEntry[] = [];
  for (const raw of asArray(body.choices)) {
    const choice = asRecord(raw);
    if (!choice) continue;
    if (typeof choice.text === "string") {
      if (choice.text) out.push({ role: "assistant", kind: "text", text: choice.text });
      continue;
    }
    out.push(...messageEntries({ role: "assistant", ...(asRecord(choice.message) ?? {}) }));
  }
  if (body.type === "message" || (asString(body.role) === "assistant" && Array.isArray(body.content))) {
    out.push(...contentEntries("assistant", body.content));
  }
  for (const item of asArray(body.output)) {
    const rec = asRecord(item);
    if (rec && asString(rec.type) === "message") out.push(...contentEntries(asString(rec.role) || "assistant", rec.content));
    else out.push(...messageEntries(item).map((entry) => ({ ...entry, role: "assistant" })));
  }
  if (typeof body.text === "string" && body.text) out.push({ role: "assistant", kind: "text", text: body.text });
  for (const raw of asArray(body.data)) {
    const item = asRecord(raw);
    if (item && (typeof item.b64_json === "string" || typeof item.url === "string")) {
      out.push({ role: "assistant", kind: "media", text: "image" });
    }
  }
  return out;
}
