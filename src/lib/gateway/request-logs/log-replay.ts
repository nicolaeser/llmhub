import type { JsonMap } from "@/types/gateway";
import type { Msg, ReplayDraft } from "@/types/playground";

type Part = Exclude<Msg["content"], string>[number];

type Draft = { system: string[]; messages: Msg[]; dropped: boolean };

const REPLAY_ENDPOINT = /\/(?:chat\/completions|completions|messages|responses|playground\/chat|assistant\/chat)$/;
const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
const SKIPPED_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
const TOOL_TYPES = new Set(["", "function", "custom"]);

function record(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function imageUrl(part: JsonMap): string {
  const source = record(part.source);
  const url =
    typeof part.image_url === "string"
      ? part.image_url
      : str(record(part.image_url)?.url) || (str(source?.type) === "url" ? str(source?.url) : "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function partsOf(content: unknown, draft: Draft): Part[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Part[] = [];
  for (const raw of list(content)) {
    if (typeof raw === "string") {
      if (raw) out.push({ type: "text", text: raw });
      continue;
    }
    const part = record(raw);
    if (!part) continue;
    const type = str(part.type);
    if (typeof part.text === "string" && (type === "" || type.endsWith("text"))) {
      if (part.text) out.push({ type: "text", text: part.text });
      continue;
    }
    const url = IMAGE_TYPES.has(type) ? imageUrl(part) : "";
    if (url) out.push({ type: "image_url", image_url: { url } });
    else if (!SKIPPED_TYPES.has(type)) draft.dropped = true;
  }
  return out;
}

function textOf(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
}

function addSystem(draft: Draft, content: unknown) {
  const parts = partsOf(content, draft);
  if (parts.some((part) => part.type !== "text")) draft.dropped = true;
  const text = textOf(parts);
  if (text) draft.system.push(text);
}

function addMessage(draft: Draft, raw: unknown) {
  if (typeof raw === "string") {
    if (raw) draft.messages.push({ role: "user", content: raw });
    return;
  }
  const message = record(raw);
  if (!message) return;
  const type = str(message.type);
  if (type && type !== "message") {
    if (!SKIPPED_TYPES.has(type)) draft.dropped = true;
    return;
  }
  const role = str(message.role) || "user";
  if (role === "system" || role === "developer") {
    addSystem(draft, message.content);
    return;
  }
  if (role !== "user" && role !== "assistant") {
    draft.dropped = true;
    return;
  }
  if (list(message.tool_calls).length || message.function_call) draft.dropped = true;
  const parts = partsOf(message.content, draft);
  if (!parts.length) return;
  const only = parts.length === 1 ? parts[0] : undefined;
  draft.messages.push({ role, content: only?.type === "text" ? only.text : parts });
}

function chatTool(raw: unknown): JsonMap | null {
  const tool = record(raw);
  if (!tool) return null;
  const fn = record(tool.function);
  if (fn) return str(fn.name) ? { type: "function", function: fn } : null;
  const name = str(tool.name);
  if (!name || !TOOL_TYPES.has(str(tool.type))) return null;
  const description = str(tool.description);
  const parameters = record(tool.parameters) ?? record(tool.input_schema);
  return {
    type: "function",
    function: { name, ...(description ? { description } : {}), ...(parameters ? { parameters } : {}) },
  };
}

function promptOf(message: Msg): ReplayDraft["prompt"] {
  if (typeof message.content === "string") return { text: message.content, images: [] };
  return {
    text: textOf(message.content),
    images: message.content.flatMap((part) => (part.type === "image_url" ? [part.image_url.url] : [])),
  };
}

export function replayDraft(endpoint: string, request: unknown): ReplayDraft | null {
  if (!REPLAY_ENDPOINT.test(endpoint)) return null;
  const body = record(request);
  if (!body) return null;
  const draft: Draft = { system: [], messages: [], dropped: false };
  if (body.system !== undefined) addSystem(draft, body.system);
  if (typeof body.instructions === "string" && body.instructions) draft.system.push(body.instructions);
  for (const message of list(body.messages)) addMessage(draft, message);
  if (Array.isArray(body.input)) {
    for (const item of body.input) addMessage(draft, item);
  } else {
    addMessage(draft, body.input);
  }
  const prompts = typeof body.prompt === "string" ? [body.prompt] : list(body.prompt).filter((item) => typeof item === "string");
  if (prompts.length > 1) draft.dropped = true;
  addMessage(draft, prompts[0]);
  const last = draft.messages.findLastIndex((message) => message.role === "user");
  if (last < 0) return null;
  if (last < draft.messages.length - 1) draft.dropped = true;
  const tools: JsonMap[] = [];
  for (const raw of list(body.tools)) {
    const tool = chatTool(raw);
    if (tool) tools.push(tool);
    else draft.dropped = true;
  }
  return {
    system: draft.system.join("\n\n"),
    history: draft.messages.slice(0, last),
    prompt: promptOf(draft.messages[last]!),
    tools,
    dropped: draft.dropped,
  };
}
