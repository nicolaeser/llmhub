import { asArray, asRecord, asString } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";
import type { PlaygroundMessage, ReplayDraft } from "@/types/playground";

type Part = Exclude<PlaygroundMessage["content"], string>[number];

type Draft = { system: string[]; messages: PlaygroundMessage[]; dropped: boolean };

const REPLAY_ENDPOINT = /\/(?:chat\/completions|completions|messages|responses|playground\/chat|assistant\/chat)$/;
const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
const SKIPPED_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
const TOOL_TYPES = new Set(["", "function", "custom"]);

function imageUrl(part: JsonMap): string {
  const source = asRecord(part.source);
  const url =
    typeof part.image_url === "string"
      ? part.image_url
      : asString(asRecord(part.image_url)?.url) || (asString(source?.type) === "url" ? asString(source?.url) : "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function partsOf(content: unknown, draft: Draft): Part[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Part[] = [];
  for (const raw of asArray(content)) {
    if (typeof raw === "string") {
      if (raw) out.push({ type: "text", text: raw });
      continue;
    }
    const part = asRecord(raw);
    if (!part) continue;
    const type = asString(part.type);
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
  const message = asRecord(raw);
  if (!message) return;
  const type = asString(message.type);
  if (type && type !== "message") {
    if (!SKIPPED_TYPES.has(type)) draft.dropped = true;
    return;
  }
  const role = asString(message.role) || "user";
  if (role === "system" || role === "developer") {
    addSystem(draft, message.content);
    return;
  }
  if (role !== "user" && role !== "assistant") {
    draft.dropped = true;
    return;
  }
  if (asArray(message.tool_calls).length || message.function_call) draft.dropped = true;
  const parts = partsOf(message.content, draft);
  if (!parts.length) return;
  const only = parts.length === 1 ? parts[0] : undefined;
  draft.messages.push({ role, content: only?.type === "text" ? only.text : parts });
}

function chatTool(raw: unknown): JsonMap | null {
  const tool = asRecord(raw);
  if (!tool) return null;
  const fn = asRecord(tool.function);
  if (fn) return asString(fn.name) ? { type: "function", function: fn } : null;
  const name = asString(tool.name);
  if (!name || !TOOL_TYPES.has(asString(tool.type))) return null;
  const description = asString(tool.description);
  const parameters = asRecord(tool.parameters) ?? asRecord(tool.input_schema);
  return {
    type: "function",
    function: { name, ...(description ? { description } : {}), ...(parameters ? { parameters } : {}) },
  };
}

function promptOf(message: PlaygroundMessage): ReplayDraft["prompt"] {
  if (typeof message.content === "string") return { text: message.content, images: [] };
  return {
    text: textOf(message.content),
    images: message.content.flatMap((part) => (part.type === "image_url" ? [part.image_url.url] : [])),
  };
}

export function replayDraft(endpoint: string, request: unknown): ReplayDraft | null {
  if (!REPLAY_ENDPOINT.test(endpoint)) return null;
  const body = asRecord(request);
  if (!body) return null;
  const draft: Draft = { system: [], messages: [], dropped: false };
  if (body.system !== undefined) addSystem(draft, body.system);
  if (typeof body.instructions === "string" && body.instructions) draft.system.push(body.instructions);
  for (const message of asArray(body.messages)) addMessage(draft, message);
  if (Array.isArray(body.input)) {
    for (const item of body.input) addMessage(draft, item);
  } else {
    addMessage(draft, body.input);
  }
  const prompts = typeof body.prompt === "string" ? [body.prompt] : asArray(body.prompt).filter((item) => typeof item === "string");
  if (prompts.length > 1) draft.dropped = true;
  addMessage(draft, prompts[0]);
  const last = draft.messages.findLastIndex((message) => message.role === "user");
  if (last < 0) return null;
  if (last < draft.messages.length - 1) draft.dropped = true;
  const tools: JsonMap[] = [];
  for (const raw of asArray(body.tools)) {
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
