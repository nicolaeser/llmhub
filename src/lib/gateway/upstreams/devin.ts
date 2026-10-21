import { createHash, randomUUID } from "node:crypto";
import { asNumber, asRecord, asString, newId, stringifyContent } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { claudeCodeCacheKey } from "@/lib/gateway/protocols/messages";
import { DEVIN_SIGNATURE_PREFIX } from "@/lib/gateway/protocols/reasoning-signature";
import { completionFromChunks } from "@/lib/gateway/protocols/sse-completion";
import { clientMetadata, DEVIN_DAY_SECONDS, DEVIN_WEEK_SECONDS } from "@/lib/gateway/upstreams/devin-account";
import { devinMaxOutputTokens, devinModelUid } from "@/lib/gateway/upstreams/devin-models";
import {
  CONNECT_FLAG_END_STREAM,
  ConnectFrameReader,
  ProtoWriter,
  WIRE_BYTES,
  WIRE_FIXED32,
  WIRE_VARINT,
  connectEnvelope,
  protoFields,
  protoFloat,
  protoNumber,
  protoText,
  safeProtoFields,
} from "@/lib/gateway/upstreams/devin-wire";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type {
  ConnectFrame,
  DevinFrame,
  DevinImage,
  DevinPrompt,
  DevinPromptSource,
  DevinResetLookup,
  DevinTierMode,
  DevinTool,
  DevinToolCall,
  DevinToolCallDelta,
  DevinTrailer,
  DevinUsage,
} from "@/types/devin";
import type { ModelFacts } from "@/types/routing";

const USER: DevinPromptSource = 1;
const ASSISTANT: DevinPromptSource = 2;
const TOOL: DevinPromptSource = 4;
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const TEXT_PARTS = new Set(["text", "input_text"]);
const EMPTY_TOOL_RESULT = "{}";
const TOOL_ID_PREFIX = "devin_call_";
const PORTABLE_ID = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PATTERN = /^([A-Za-z0-9_-]*):([A-Za-z0-9_-]+)$/;
const MAX_TOOL_CALLS = 128;
const MAX_SESSIONS = 5_000;
const DEFAULT_TEMPERATURE = 1;
const TOP_K = 40;
const TOP_P = Math.fround(0.95);
const COMPLETION_MODE = 400;
const REQUEST_FLAG = 5;
const SESSION_KIND = 4;
const USER_TURN_MARK = 14;
const MAX_SESSION_KEY = 512;
const STOP_LENGTH = new Set([1, 3]);
const STOP_CONTENT_FILTER = 11;
const TRUNCATED = "devin stream ended before the response completed";
const QUOTA_PERIODS: readonly (readonly [string, number])[] = [
  ["weekly", DEVIN_WEEK_SECONDS],
  ["daily", DEVIN_DAY_SECONDS],
];
const LIMIT_WORDS = ["quota", "credit", "acu", "exhausted", "limit"];
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const sessionTurns = new Map<string, number>();

function unsupported(message: string): GateError {
  return new GateError(400, "unsupported_parameter", message, { param: "messages" });
}

export function encodeToolCallId(id: string): string {
  if (!id || (PORTABLE_ID.test(id) && !id.startsWith(TOOL_ID_PREFIX))) return id;
  return `${TOOL_ID_PREFIX}${Buffer.from(id, "utf8").toString("base64url")}`;
}

export function decodeToolCallId(id: string): string {
  if (!id.startsWith(TOOL_ID_PREFIX)) return id;
  const encoded = id.slice(TOOL_ID_PREFIX.length);
  if (!PORTABLE_ID.test(encoded)) return id;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return decoded && encodeToolCallId(decoded) === id ? decoded : id;
}

export function devinSignature(type: string, bytes: Uint8Array): string {
  return `${DEVIN_SIGNATURE_PREFIX}${type.replace(/[^A-Za-z0-9_-]/g, "")}:${Buffer.from(bytes).toString("base64url")}`;
}

export function parseDevinSignature(value: unknown): { type: string; bytes: Uint8Array } | null {
  const text = asString(value);
  if (!text.startsWith(DEVIN_SIGNATURE_PREFIX)) return null;
  const match = SIGNATURE_PATTERN.exec(text.slice(DEVIN_SIGNATURE_PREFIX.length));
  if (!match) return null;
  const bytes = new Uint8Array(Buffer.from(match[2]!, "base64url"));
  return bytes.length ? { type: match[1]!, bytes } : null;
}

function dataImage(url: string): DevinImage {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(url.trim());
  if (!match) throw unsupported("devin accepts images only as base64 data URLs");
  return { mimeType: match[1] || "image/png", data: match[2]! };
}

function imageOf(part: JsonMap): DevinImage {
  const image = part.image_url;
  return dataImage(typeof image === "string" ? image : asString(asRecord(image)?.url));
}

function withImageHeaders(text: string, images: DevinImage[]): string {
  if (!images.length || text.includes("[Image ")) return text;
  const header = images
    .map((image, index) => `[Image ${index + 1}: pasted_image_${index + 1}.${IMAGE_EXTENSIONS[image.mimeType.toLowerCase()] ?? "png"}]`)
    .join("\n");
  return text ? `${header}\n\n${text}` : header;
}

function userContent(content: unknown): { text: string; images: DevinImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const texts: string[] = [];
  const images: DevinImage[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const part = asRecord(raw);
    if (!part) continue;
    const type = asString(part.type);
    if (TEXT_PARTS.has(type)) {
      const text = asString(part.text);
      if (text) texts.push(text);
    } else if (type === "image_url") {
      images.push(imageOf(part));
    } else {
      throw unsupported(`devin does not support ${type || "this"} content parts`);
    }
  }
  return { text: withImageHeaders(texts.join("\n"), images), images };
}

function toolResultContent(content: unknown): { text: string; images: DevinImage[] } {
  if (typeof content === "string") return { text: content.trim() ? content : EMPTY_TOOL_RESULT, images: [] };
  const texts: string[] = [];
  const images: DevinImage[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "image_url") images.push(imageOf(part));
    else if (typeof part.text === "string") texts.push(part.text);
    else texts.push(JSON.stringify(part));
  }
  const text = withImageHeaders(texts.join("\n"), images);
  return { text: text.trim() ? text : EMPTY_TOOL_RESULT, images };
}

function prompt(source: DevinPromptSource, fields: Partial<DevinPrompt>): DevinPrompt {
  return {
    source,
    content: "",
    images: [],
    toolCalls: [],
    toolCallId: "",
    thinking: "",
    signature: "",
    signatureType: "",
    ...fields,
  };
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function assistantPrompt(message: JsonMap, pending: string[]): DevinPrompt {
  const toolCalls: DevinToolCall[] = [];
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    const name = asString(fn?.name);
    if (!call || !name) continue;
    const id = decodeToolCallId(asString(call.id));
    toolCalls.push({ id, name, arguments: argumentsText(fn?.arguments) });
    pending.push(id);
  }
  const fields: Partial<DevinPrompt> = { content: stringifyContent(message.content), toolCalls };
  for (const raw of Array.isArray(message.thinking_blocks) ? message.thinking_blocks : []) {
    const block = asRecord(raw);
    const signature = parseDevinSignature(block?.signature);
    if (!block || !signature) continue;
    fields.thinking = asString(block.thinking);
    fields.signature = Buffer.from(signature.bytes).toString("base64");
    fields.signatureType = signature.type;
  }
  return prompt(ASSISTANT, fields);
}

function toolPrompt(message: JsonMap, pending: string[]): DevinPrompt {
  const id = decodeToolCallId(asString(message.tool_call_id));
  const { text, images } = toolResultContent(message.content);
  const index = id ? pending.indexOf(id) : pending.length ? 0 : -1;
  if (index === -1) return prompt(USER, { content: text, images });
  const [matched] = pending.splice(index, 1);
  return prompt(TOOL, { content: text, images, toolCallId: id || matched || "" });
}

function devinTools(tools: unknown): DevinTool[] {
  const out: DevinTool[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = asRecord(raw);
    const fn = asRecord(tool?.function);
    const name = asString(fn?.name);
    if (tool?.type !== "function" || !name) continue;
    out.push({
      name,
      description: asString(fn?.description),
      parameters: fn?.parameters === undefined || fn.parameters === null ? "" : JSON.stringify(fn.parameters),
    });
  }
  return out;
}

function uuidOf(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sessionOf(body: JsonMap): string {
  const key = asString(body.prompt_cache_key).trim() || claudeCodeCacheKey(body.metadata);
  return key && key.length <= MAX_SESSION_KEY ? uuidOf(key) : "";
}

function tierOf(body: JsonMap): DevinTierMode {
  const tier = asString(body.service_tier);
  return tier === "fast" || tier === "priority" ? tier : "";
}

export function chatToDevin(body: JsonMap, facts?: ModelFacts): JsonMap {
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(asRecord)
    .filter((message): message is JsonMap => message !== null);
  const system = messages
    .filter((message) => INSTRUCTION_ROLES.has(asString(message.role)))
    .map((message) => stringifyContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const pending: string[] = [];
  const prompts: DevinPrompt[] = [];
  for (const message of messages) {
    const role = asString(message.role);
    if (INSTRUCTION_ROLES.has(role)) continue;
    if (role === "assistant") prompts.push(assistantPrompt(message, pending));
    else if (role === "tool") prompts.push(toolPrompt(message, pending));
    else {
      const { text, images } = userContent(message.content);
      if (text || images.length) prompts.push(prompt(USER, { content: text, images }));
    }
  }
  const effort = asString(body.reasoning_effort) || asString(asRecord(body.reasoning)?.effort);
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : null;
  return {
    model: devinModelUid(asString(body.model), effort, facts?.variants, tierOf(body)),
    system,
    prompts,
    tools: devinTools(body.tools),
    temperature,
    maxTokens: devinMaxOutputTokens(asNumber(body.max_completion_tokens, asNumber(body.max_tokens, 0))),
    session: sessionOf(body),
  };
}

function nextTurn(session: string): number {
  const turn = sessionTurns.get(session) ?? 0;
  sessionTurns.delete(session);
  sessionTurns.set(session, turn + 1);
  while (sessionTurns.size > MAX_SESSIONS) {
    const oldest = sessionTurns.keys().next().value;
    if (oldest === undefined) break;
    sessionTurns.delete(oldest);
  }
  return turn;
}

function promptsOf(value: unknown): DevinPrompt[] {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((item): item is JsonMap => item !== null)
    .map((item) => {
      const source = asNumber(item.source, USER);
      return prompt(source === ASSISTANT || source === TOOL ? source : USER, {
        content: asString(item.content),
        images: (Array.isArray(item.images) ? item.images : [])
          .map(asRecord)
          .filter((image): image is JsonMap => image !== null)
          .map((image) => ({ data: asString(image.data), mimeType: asString(image.mimeType) })),
        toolCalls: (Array.isArray(item.toolCalls) ? item.toolCalls : [])
          .map(asRecord)
          .filter((call): call is JsonMap => call !== null)
          .map((call) => ({ id: asString(call.id), name: asString(call.name), arguments: asString(call.arguments) })),
        toolCallId: asString(item.toolCallId),
        thinking: asString(item.thinking),
        signature: asString(item.signature),
        signatureType: asString(item.signatureType),
      });
    });
}

function promptMessage(item: DevinPrompt): ProtoWriter {
  const out = new ProtoWriter().string(1, randomUUID()).varint(2, item.source).string(3, item.content);
  for (const call of item.toolCalls) {
    const encoded = new ProtoWriter();
    if (call.id) encoded.string(1, call.id);
    if (call.name) encoded.string(2, call.name);
    if (call.arguments) encoded.string(3, call.arguments);
    out.message(6, encoded);
  }
  if (item.toolCallId) out.string(7, item.toolCallId);
  for (const image of item.images) {
    if (!image.data.trim()) continue;
    out.message(10, new ProtoWriter().string(1, image.data.trim()).string(2, image.mimeType.trim() || "image/png"));
  }
  if (item.thinking) out.string(11, item.thinking);
  if (item.signature) out.bytes(12, new Uint8Array(Buffer.from(item.signature, "base64")));
  if (item.signatureType) out.string(18, item.signatureType);
  return out;
}

export function encodeDevinRequest(payload: JsonMap, token: string): Uint8Array<ArrayBuffer> {
  const prompts = promptsOf(payload.prompts);
  const session = asString(payload.session) || randomUUID();
  const out = new ProtoWriter().message(1, clientMetadata(token));
  const system = asString(payload.system);
  if (system) out.string(2, system);
  for (const item of prompts) out.message(3, promptMessage(item));
  out.varint(7, REQUEST_FLAG);
  out.message(
    8,
    new ProtoWriter()
      .varint(1, 1)
      .varint(2, devinMaxOutputTokens(asNumber(payload.maxTokens, 0)))
      .varint(3, COMPLETION_MODE)
      .double(5, typeof payload.temperature === "number" ? payload.temperature : DEFAULT_TEMPERATURE)
      .varint(7, TOP_K)
      .double(8, TOP_P),
  );
  for (const raw of Array.isArray(payload.tools) ? payload.tools : []) {
    const tool = asRecord(raw);
    const name = asString(tool?.name);
    if (!name) continue;
    const encoded = new ProtoWriter().string(1, name);
    const description = asString(tool?.description);
    if (description) encoded.string(2, description);
    const parameters = asString(tool?.parameters);
    if (parameters) encoded.string(3, parameters);
    out.message(10, encoded);
  }
  const turn = nextTurn(session);
  const thread = new ProtoWriter().string(1, session);
  if (turn > 0) thread.varint(2, turn);
  thread.varint(3, SESSION_KIND);
  const last = prompts[prompts.length - 1];
  const previous = prompts[prompts.length - 2];
  if (last?.source === USER && (turn === 0 || !previous || previous.source !== USER)) thread.varint(4, USER_TURN_MARK);
  out.message(15, thread);
  out.string(16, session);
  out.varint(20, 1);
  out.string(21, asString(payload.model));
  return connectEnvelope(out.finish());
}

function usageOf(data: Uint8Array): DevinUsage {
  const usage: DevinUsage = { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0, model: "" };
  for (const field of safeProtoFields(data)) {
    if (field.wire === WIRE_VARINT) {
      const value = protoNumber(field);
      if (field.field === 2) usage.prompt += value;
      if (field.field === 3) usage.completion = value;
      if (field.field === 4) usage.cacheWrite += value;
      if (field.field === 5) usage.cacheRead = value;
    } else if (field.wire === WIRE_BYTES && field.field === 9) {
      usage.model = protoText(field);
    }
  }
  return usage;
}

function toolDeltaOf(data: Uint8Array): DevinToolCallDelta {
  const delta: DevinToolCallDelta = { id: "", name: "", arguments: "" };
  let invalid = "";
  for (const field of safeProtoFields(data)) {
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 1) delta.id = protoText(field);
    if (field.field === 2) delta.name = protoText(field);
    if (field.field === 3) delta.arguments = protoText(field);
    if (field.field === 4) invalid = protoText(field);
  }
  if (!delta.arguments) delta.arguments = invalid;
  return delta;
}

export function parseDevinFrame(payload: Uint8Array): DevinFrame {
  const frame: DevinFrame = {
    text: [],
    thinking: [],
    signature: new Uint8Array(),
    signatureType: "",
    toolCalls: [],
    usage: null,
    stopReason: 0,
    dimensions: [],
  };
  const signature: Uint8Array[] = [];
  for (const field of protoFields(payload)) {
    if (field.wire === WIRE_VARINT && field.field === 5) frame.stopReason = protoNumber(field);
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 3) frame.text.push(field.bytes);
    if (field.field === 6) frame.toolCalls.push(toolDeltaOf(field.bytes));
    if (field.field === 7) frame.usage = usageOf(field.bytes);
    if (field.field === 9) frame.thinking.push(field.bytes);
    if (field.field === 10) signature.push(field.bytes);
    if (field.field === 21) frame.signatureType = protoText(field);
    if (field.field === 28) frame.dimensions.push(field.bytes);
  }
  frame.signature = new Uint8Array(Buffer.concat(signature));
  return frame;
}

function metricOf(data: Uint8Array): { key: string; value: number } {
  let key = "";
  let value = 0;
  for (const field of safeProtoFields(data)) {
    if (field.wire !== WIRE_BYTES) continue;
    if (field.field === 5) key = protoText(field);
    if (field.field === 4) {
      const reading = safeProtoFields(field.bytes).find((item) => item.field === 2 && item.wire === WIRE_FIXED32);
      if (reading) value = protoFloat(reading);
    }
  }
  return { key, value };
}

export function dimensionUsage(groups: Uint8Array[]): Pick<DevinUsage, "prompt" | "completion" | "cacheRead"> | null {
  for (const group of groups) {
    const fields = safeProtoFields(group);
    const title = fields.find((field) => field.field === 1 && field.wire === WIRE_BYTES);
    if (!title || protoText(title).toLowerCase() !== "token usage") continue;
    const usage = { prompt: 0, completion: 0, cacheRead: 0 };
    let found = false;
    for (const field of fields) {
      if (field.field !== 2 || field.wire !== WIRE_BYTES) continue;
      const metric = metricOf(field.bytes);
      if (metric.key === "input_tokens") usage.prompt = Math.trunc(metric.value);
      else if (metric.key === "output_tokens") usage.completion = Math.trunc(metric.value);
      else if (metric.key === "cached_input_tokens") usage.cacheRead = Math.trunc(metric.value);
      else continue;
      found = true;
    }
    if (found) return usage;
  }
  return null;
}

function trailerStatus(code: string, message: string): number {
  const lower = message.toLowerCase();
  switch (code) {
    case "invalid_argument":
      return lower.includes("internal error") ? 502 : 400;
    case "unauthenticated":
      return 401;
    case "permission_denied":
      return lower.includes("high demand") ? 429 : 403;
    case "resource_exhausted":
      return 429;
    case "unavailable":
      return 503;
    case "canceled":
      return 499;
    case "deadline_exceeded":
      return 504;
    case "failed_precondition":
      return LIMIT_WORDS.some((word) => lower.includes(word)) ? 429 : 400;
    default:
      return 502;
  }
}

export function parseDevinTrailer(payload: Uint8Array): DevinTrailer | null {
  const text = new TextDecoder().decode(payload).trim();
  if (!text || text === "{}") return null;
  const error = asRecord(asRecord(parseJsonOrNull(text))?.error);
  if (!error) return null;
  const code = asString(error.code).toLowerCase();
  const message = asString(error.message);
  return { status: trailerStatus(code, message), code, message };
}

export function devinQuotaWindow(message: string): number | null {
  const lower = message.toLowerCase();
  if (!lower.includes("quota") || !lower.includes("exhausted")) return null;
  return QUOTA_PERIODS.find(([word]) => lower.includes(word))?.[1] ?? null;
}

export function devinUpstreamError(trailer: DevinTrailer, resetAt?: DevinResetLookup): GateError {
  const window = trailer.status === 429 ? devinQuotaWindow(trailer.message) : null;
  const passCode = trailer.status !== 401 && trailer.status !== 403 ? trailer.code : "";
  return new GateError(trailer.status, "upstream_error", trailer.message || `devin upstream error (${trailer.code || "unknown"})`, {
    upstreamCode: passCode || undefined,
    retryAt: window && resetAt ? resetAt(window) : null,
  });
}

export function devinHttpError(status: number, text: string, resetAt?: DevinResetLookup): GateError {
  const rec = asRecord(parseJsonOrNull(text));
  const code = asString(rec?.code).toLowerCase();
  const message = asString(rec?.message) || asString(asRecord(rec?.error)?.message) || text.slice(0, 512) || `upstream returned ${status}`;
  return devinUpstreamError({ status: status || 502, code, message }, resetAt);
}

type ToolSlot = { index: number; id: string; name: string; pending: string; started: boolean };

export class DevinChatTranslator {
  private id = `chatcmpl_${newId()}`;
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  private textDecoder = new TextDecoder();
  private thinkingDecoder = new TextDecoder();
  private thinking = "";
  private signature: Uint8Array[] = [];
  private signatureType = "";
  private slots: ToolSlot[] = [];
  private current: ToolSlot | null = null;
  private usage: DevinUsage | null = null;
  private stopReason = 0;
  private ended = false;

  constructor(
    private model: string,
    private resetAt?: DevinResetLookup,
  ) {}

  get done(): boolean {
    return this.ended;
  }

  push(frame: ConnectFrame): string[] {
    if (this.ended) return [];
    if (frame.flag & CONNECT_FLAG_END_STREAM) {
      const trailer = parseDevinTrailer(frame.payload);
      if (trailer) throw devinUpstreamError(trailer, this.resetAt);
      this.ended = true;
      return this.final();
    }
    let parsed: DevinFrame;
    try {
      parsed = parseDevinFrame(frame.payload);
    } catch {
      return [];
    }
    return this.translate(parsed);
  }

  finish(): string[] {
    if (!this.ended) throw new GateError(502, "upstream_error", TRUNCATED);
    return [];
  }

  private chunk(delta: JsonMap, finish: string | null = null, usage?: JsonMap): string {
    const role = this.started ? {} : { role: "assistant" };
    this.started = true;
    return JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { ...role, ...delta }, logprobs: null, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
  }

  private mergeUsage(next: DevinUsage): void {
    if (!this.usage) {
      this.usage = { ...next };
      return;
    }
    if (next.prompt > 0) this.usage.prompt = next.prompt;
    if (next.completion > 0) this.usage.completion = next.completion;
    if (next.cacheRead > 0) this.usage.cacheRead = next.cacheRead;
    if (next.cacheWrite > 0) this.usage.cacheWrite = next.cacheWrite;
    if (next.model) this.usage.model = next.model;
  }

  private fillFromDimensions(groups: Uint8Array[]): void {
    if (!groups.length) return;
    const current = this.usage;
    if (current && current.prompt > 0 && current.completion > 0 && current.cacheRead > 0) return;
    const measured = dimensionUsage(groups);
    if (!measured) return;
    const usage = current ?? { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0, model: "" };
    if (!usage.prompt) usage.prompt = measured.prompt;
    if (!usage.completion) usage.completion = measured.completion;
    if (!usage.cacheRead) usage.cacheRead = measured.cacheRead;
    this.usage = usage;
  }

  private startSlot(slot: ToolSlot, out: string[]): void {
    slot.started = true;
    if (!slot.id) slot.id = `call_${newId()}`;
    out.push(
      this.chunk({
        tool_calls: [{ index: slot.index, id: slot.id, type: "function", function: { name: slot.name, arguments: slot.pending } }],
      }),
    );
    slot.pending = "";
  }

  private toolDelta(delta: DevinToolCallDelta, out: string[]): void {
    const id = encodeToolCallId(delta.id);
    let slot = id ? this.slots.find((item) => item.id === id) : this.current;
    if (!slot) {
      if (this.slots.length >= MAX_TOOL_CALLS) return;
      slot = { index: this.slots.length, id, name: delta.name, pending: "", started: false };
      this.slots.push(slot);
    }
    this.current = slot;
    if (!slot.started && !slot.id && id) slot.id = id;
    if (!slot.name && delta.name) slot.name = delta.name;
    if (!slot.started) {
      slot.pending += delta.arguments;
      if (slot.name) this.startSlot(slot, out);
      return;
    }
    if (delta.arguments) out.push(this.chunk({ tool_calls: [{ index: slot.index, function: { arguments: delta.arguments } }] }));
  }

  private translate(frame: DevinFrame): string[] {
    const out: string[] = [];
    if (frame.stopReason) this.stopReason = frame.stopReason;
    if (frame.usage) this.mergeUsage(frame.usage);
    this.fillFromDimensions(frame.dimensions);
    if (frame.signature.length) this.signature.push(frame.signature);
    if (frame.signatureType) this.signatureType = frame.signatureType;
    for (const bytes of frame.thinking) {
      const text = this.thinkingDecoder.decode(bytes, { stream: true });
      this.thinking += text;
      if (text) out.push(this.chunk({ reasoning_content: text }));
    }
    for (const delta of frame.toolCalls) this.toolDelta(delta, out);
    for (const bytes of frame.text) {
      const text = this.textDecoder.decode(bytes, { stream: true });
      if (text) out.push(this.chunk({ content: text }));
    }
    return out;
  }

  private usageChunk(): JsonMap {
    const usage = this.usage ?? { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0, model: "" };
    const prompt = usage.prompt + usage.cacheWrite + usage.cacheRead;
    return {
      prompt_tokens: prompt,
      completion_tokens: usage.completion,
      total_tokens: prompt + usage.completion,
      prompt_tokens_details: { cached_tokens: usage.cacheRead },
      ...(usage.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
      ...(usage.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
    };
  }

  private finishReason(): string {
    if (this.slots.length) return "tool_calls";
    if (STOP_LENGTH.has(this.stopReason)) return "length";
    if (this.stopReason === STOP_CONTENT_FILTER) return "content_filter";
    return "stop";
  }

  private final(): string[] {
    const out: string[] = [];
    const thinkingTail = this.thinkingDecoder.decode();
    if (thinkingTail) {
      this.thinking += thinkingTail;
      out.push(this.chunk({ reasoning_content: thinkingTail }));
    }
    const textTail = this.textDecoder.decode();
    if (textTail) out.push(this.chunk({ content: textTail }));
    for (const slot of this.slots) if (!slot.started) this.startSlot(slot, out);
    const signature = new Uint8Array(Buffer.concat(this.signature));
    if (signature.length) {
      out.push(
        this.chunk({
          thinking_blocks: [{ type: "thinking", thinking: this.thinking, signature: devinSignature(this.signatureType, signature) }],
        }),
      );
    }
    out.push(this.chunk({}, this.finishReason(), this.usageChunk()));
    return out;
  }
}

export function devinCompletion(raw: Uint8Array, model: string, resetAt?: DevinResetLookup): JsonMap {
  const translator = new DevinChatTranslator(model, resetAt);
  const reader = new ConnectFrameReader();
  const chunks: string[] = [];
  for (const frame of reader.push(raw)) chunks.push(...translator.push(frame));
  chunks.push(...translator.finish());
  return completionFromChunks(chunks, model);
}

function sseLine(payload: string): string {
  return `data: ${payload}\n\n`;
}

export async function devinEventStream(res: Response, model: string, resetAt?: DevinResetLookup): Promise<Response> {
  if (!res.body) throw new GateError(502, "upstream_error", TRUNCATED);
  const reader = res.body.getReader();
  const frames = new ConnectFrameReader();
  const translator = new DevinChatTranslator(model, resetAt);
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let finished = false;

  const advance = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) {
      queued.push(...translator.finish());
      finished = true;
      return;
    }
    for (const frame of frames.push(value)) queued.push(...translator.push(frame));
    if (translator.done) finished = true;
  };

  try {
    while (!queued.length && !finished) await advance();
  } catch (err) {
    await cancelQuietly(reader);
    throw err;
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!queued.length && !finished) await advance();
      if (queued.length) {
        controller.enqueue(encoder.encode(queued.splice(0).map(sseLine).join("")));
        return;
      }
      controller.enqueue(encoder.encode(sseLine("[DONE]")));
      controller.close();
      await cancelQuietly(reader);
    },
    async cancel() {
      await cancelQuietly(reader);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
