import { arch, platform } from "node:os";
import { asRecord, asString, VERSION } from "@/lib/gateway/core";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { JsonMap } from "@/types/gateway";
import type { KimiCodeKind, LimitWindow, SubscriptionLimits } from "@/types/providers";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_PLATFORM = "llmhub";
export const KIMI_REASONING_UNAVAILABLE = "[reasoning unavailable]";

const KIMI_AUTH_HOSTS: Record<KimiCodeKind, string> = {
  kimi: "https://auth.kimi.com",
  kimi_ai: "https://auth.kimi.ai",
};
const KIMI_DEVICE_NAME = "LLM Hub";
const THINKING_TEMPERATURE = 1;
const PLAIN_TEMPERATURE = 0.6;
const MAX_EFFORT_MODELS = /(?:^|[^a-z0-9])k(?:3|2[.-]8)(?:$|[^0-9])/i;
const KIMI_MODEL = /(?:^|[^a-z0-9])(?:k2|k3|kimi-for-coding)/i;
const OPEN_EFFORTS: Record<string, string> = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };
const DISABLED_EFFORTS = new Set(["none", "disabled", "off"]);
const MAX_SCHEMA_DEPTH = 32;
const MAX_INLINED_BYTES = 256 * 1024;
const WEEK_SECONDS = 7 * 86_400;
const UNIT_SECONDS: [string, number][] = [
  ["SECOND", 1],
  ["MINUTE", 60],
  ["HOUR", 3_600],
  ["DAY", 86_400],
  ["WEEK", WEEK_SECONDS],
];
const RESET_AT_KEYS = ["reset_at", "resetAt", "reset_time", "resetTime"];
const RESET_IN_KEYS = ["reset_in", "resetIn", "ttl"];
const LABEL_KEYS = ["name", "title", "scope"];

export function kimiAuthHost(kind: KimiCodeKind): string {
  return KIMI_AUTH_HOSTS[kind];
}

export function kimiApiBase(kind: KimiCodeKind): string {
  return PROVIDER_CATALOG.find((spec) => spec.kind === kind)?.default_base_url ?? "";
}

export function kimiUsageUrl(kind: KimiCodeKind): string {
  return `${kimiApiBase(kind)}/usages`;
}

export function kimiHeaders(device = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": `LLMHub/${VERSION}`,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": VERSION,
    "X-Msh-Device-Name": KIMI_DEVICE_NAME,
    "X-Msh-Device-Model": `${platform()} ${arch()}`,
  };
  if (device) headers["X-Msh-Device-Id"] = device;
  return headers;
}

function requestedEffort(body: JsonMap): string {
  return (asString(body.reasoning_effort) || asString(asRecord(body.reasoning)?.effort)).trim().toLowerCase();
}

function kimiCodeEffort(effort: string, model: string): string {
  if (effort === "auto") return "auto";
  if (effort === "xhigh" || effort === "max") return MAX_EFFORT_MODELS.test(model) ? "max" : "high";
  return effort === "minimal" || effort === "low" ? "low" : "high";
}

function withThinking(body: JsonMap, code: boolean): JsonMap {
  const effort = requestedEffort(body);
  const out = { ...body };
  delete out.reasoning;
  if (!effort) return out;
  if (asRecord(out.thinking)) {
    delete out.reasoning_effort;
    return out;
  }
  if (DISABLED_EFFORTS.has(effort)) {
    delete out.reasoning_effort;
    out.thinking = { type: "disabled" };
    return out;
  }
  if (code) {
    delete out.reasoning_effort;
    out.thinking = { type: "enabled", effort: kimiCodeEffort(effort, asString(out.model)) };
    return out;
  }
  out.reasoning_effort = OPEN_EFFORTS[effort] ?? effort;
  return out;
}

function withTemperature(body: JsonMap, code: boolean): JsonMap {
  if (typeof body.temperature !== "number") return body;
  if (!code && !KIMI_MODEL.test(asString(body.model))) return body;
  const disabled = asString(asRecord(body.thinking)?.type).toLowerCase() === "disabled";
  if (body.temperature === (disabled ? PLAIN_TEMPERATURE : THINKING_TEMPERATURE)) return body;
  const out = { ...body };
  delete out.temperature;
  return out;
}

function hasToolCalls(message: JsonMap): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function hasFunctionCall(message: JsonMap): boolean {
  const call = asRecord(message.function_call);
  return call !== null && Object.keys(call).length > 0;
}

function usableReasoning(value: unknown): value is string {
  const text = typeof value === "string" ? value.trim() : "";
  return text !== "" && text !== KIMI_REASONING_UNAVAILABLE;
}

function emptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  return content.every((part) => {
    if (part === null || part === undefined) return true;
    if (typeof part === "string") return part.trim() === "";
    const rec = asRecord(part);
    if (!rec) return false;
    if (typeof rec.text === "string") return rec.text.trim() === "";
    return rec.type === "text" || Object.keys(rec).length === 0;
  });
}

function droppable(message: JsonMap): boolean {
  if (message.role !== "assistant") return false;
  if (hasToolCalls(message) || hasFunctionCall(message)) return false;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return false;
  return emptyContent(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asString(asRecord(part)?.text).trim())
    .filter(Boolean)
    .join("\n");
}

export function kimiToolMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const out: unknown[] = [];
  const pending: string[] = [];
  let latestReasoning = "";
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) {
      out.push(raw);
      continue;
    }
    if (droppable(message)) continue;
    if (message.role === "assistant") {
      if (usableReasoning(message.reasoning_content)) latestReasoning = message.reasoning_content;
      if (!hasToolCalls(message)) {
        out.push(message);
        continue;
      }
      const patched = usableReasoning(message.reasoning_content)
        ? message
        : {
            ...message,
            reasoning_content: latestReasoning || contentText(message.content) || KIMI_REASONING_UNAVAILABLE,
          };
      for (const call of patched.tool_calls as unknown[]) {
        const id = asString(asRecord(call)?.id).trim();
        if (id) pending.push(id);
      }
      out.push(patched);
      continue;
    }
    if (message.role !== "tool") {
      out.push(message);
      continue;
    }
    let id = asString(message.tool_call_id).trim();
    let patched = message;
    if (!id) {
      id = asString(message.call_id).trim() || (pending.length === 1 ? pending[0]! : "");
      if (id) patched = { ...message, tool_call_id: id };
    }
    const index = pending.indexOf(id);
    if (id && index >= 0) pending.splice(index, 1);
    out.push(patched);
  }
  return out;
}

function pointerTarget(root: JsonMap, ref: string): JsonMap | null {
  if (!ref.startsWith("#")) return null;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    const rec = asRecord(node);
    if (Array.isArray(node)) node = node[Number(key)];
    else if (rec) node = rec[key];
    else return null;
  }
  return asRecord(node);
}

function inlineNode(node: unknown, root: JsonMap, trail: string[], budget: { left: number }, depth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineNode(item, root, trail, budget, depth + 1));
  const rec = asRecord(node);
  if (!rec) return node;
  if (depth > MAX_SCHEMA_DEPTH) return { type: "object" };
  if (typeof rec.$ref === "string") {
    const ref = rec.$ref;
    const target = pointerTarget(root, ref);
    const siblings = { ...rec };
    delete siblings.$ref;
    if (!target) return inlineNode(siblings, root, trail, budget, depth + 1);
    const size = JSON.stringify(target).length;
    if (trail.includes(ref) || size > budget.left) {
      const hint: JsonMap = { type: asString(target.type) || "object" };
      if (typeof target.description === "string") hint.description = target.description.slice(0, 512);
      return { ...hint, ...(inlineNode(siblings, root, trail, budget, depth + 1) as JsonMap) };
    }
    budget.left -= size;
    const resolved = inlineNode(target, root, [...trail, ref], budget, depth + 1) as JsonMap;
    return { ...resolved, ...(inlineNode(siblings, root, trail, budget, depth + 1) as JsonMap) };
  }
  const out: JsonMap = {};
  for (const [key, value] of Object.entries(rec)) out[key] = inlineNode(value, root, trail, budget, depth + 1);
  return out;
}

export function kimiParameters(schema: unknown): unknown {
  const root = asRecord(schema);
  if (!root) return schema;
  const out = JSON.stringify(root).includes('"$ref"')
    ? (inlineNode(root, root, [], { left: MAX_INLINED_BYTES }, 0) as JsonMap)
    : { ...root };
  delete out.$defs;
  delete out.definitions;
  if (out.type === undefined) out.type = "object";
  return out;
}

function kimiTool(raw: unknown): unknown {
  const tool = asRecord(raw);
  if (!tool) return raw;
  if (tool.type === "namespace") {
    const out = { ...tool };
    for (const key of ["tools", "children"]) {
      if (Array.isArray(tool[key])) out[key] = (tool[key] as unknown[]).map(kimiTool);
    }
    return out;
  }
  const fn = asRecord(tool.function);
  if (fn && asRecord(fn.parameters)) return { ...tool, function: { ...fn, parameters: kimiParameters(fn.parameters) } };
  if (asRecord(tool.parameters)) return { ...tool, parameters: kimiParameters(tool.parameters) };
  return tool;
}

export function kimiTools(body: JsonMap): JsonMap {
  const out = { ...body };
  if (Array.isArray(body.tools)) out.tools = body.tools.map(kimiTool);
  if (Array.isArray(body.functions)) out.functions = body.functions.map(kimiTool);
  return out;
}

export function kimiChatBody(body: JsonMap, kind: string): JsonMap {
  const code = kind === "kimi" || kind === "kimi_ai";
  const thought = withThinking(body, code);
  const normalized = withTemperature(kimiTools(thought), code);
  if (Array.isArray(normalized.messages)) normalized.messages = kimiToolMessages(normalized.messages);
  return normalized;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function resetTime(data: JsonMap, now: number): string | null {
  for (const key of RESET_AT_KEYS) {
    const raw = data[key];
    const numeric = numberOf(raw);
    const at = numeric !== null ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(asString(raw));
    if (Number.isFinite(at) && at > 0) return new Date(at).toISOString();
  }
  for (const key of RESET_IN_KEYS) {
    const seconds = numberOf(data[key]);
    if (seconds !== null && seconds > 0) return new Date(now + seconds * 1000).toISOString();
  }
  return null;
}

function windowSeconds(...sources: JsonMap[]): number {
  for (const source of sources) {
    const duration = numberOf(source.duration);
    if (duration === null || duration <= 0) continue;
    const unit = asString(source.timeUnit ?? source.time_unit).toUpperCase();
    const seconds = UNIT_SECONDS.find(([name]) => unit.includes(name))?.[1] ?? 1;
    return Math.round(duration * seconds);
  }
  return 0;
}

function label(...sources: JsonMap[]): string {
  for (const source of sources) {
    for (const key of LABEL_KEYS) {
      const value = asString(source[key]).trim();
      if (value) return value;
    }
  }
  return "";
}

function usageWindow(detail: JsonMap, seconds: number, scope: string, now: number): LimitWindow | null {
  const limit = numberOf(detail.limit);
  const remaining = numberOf(detail.remaining);
  const used = numberOf(detail.used) ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null || limit <= 0 || used === null) return null;
  const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100));
  return {
    scope,
    usedPercent: Math.round(usedPercent * 10) / 10,
    windowSeconds: seconds,
    resetsAt: resetTime(detail, now),
    limitReached: usedPercent >= 100,
  };
}

export function kimiLimits(payload: JsonMap, plan: string, now = Date.now()): SubscriptionLimits {
  const windows: LimitWindow[] = [];
  for (const raw of Array.isArray(payload.limits) ? payload.limits : []) {
    const item = asRecord(raw);
    if (!item) continue;
    const detail = asRecord(item.detail) ?? item;
    const window = asRecord(item.window) ?? {};
    const parsed = usageWindow(detail, windowSeconds(window, item, detail), label(item, detail), now);
    if (parsed) windows.push(parsed);
  }
  const summary = asRecord(payload.usage);
  const weekly = summary ? usageWindow(summary, windowSeconds(summary) || WEEK_SECONDS, label(summary), now) : null;
  if (weekly && !windows.some((window) => window.scope === weekly.scope && window.windowSeconds === weekly.windowSeconds)) {
    windows.push(weekly);
  }
  return {
    plan,
    windows,
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt: new Date(now).toISOString(),
  };
}
