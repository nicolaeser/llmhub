import { asNumber, asRecord, asString, newId, stringifyContent } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { completionFromSse } from "@/lib/gateway/protocols/sse-completion";
import type { ChatSseTranslator, JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";
import type { LimitWindow, SubscriptionLimits, DiscoveredModel, UpstreamAuth } from "@/types/providers";

export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_CLIENT_VERSION = "2.17.0";
export const ANTIGRAVITY_STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const ANTIGRAVITY_SCOPE = [
  "cloud-platform",
  "userinfo.email",
  "userinfo.profile",
  "cclog",
  "experimentsandconfigs",
]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .join(" ");

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const SCHEMA_KEYS = ["type", "description", "enum", "items", "properties", "required", "nullable"] as const;
const CONSTRAINT_KEYS = [
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;
const MAX_SCHEMA_DEPTH = 12;
const CONTENT_FILTER_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);
const CLAUDE_THINKING_BUDGETS: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 32768 };
const GEMINI_BUDGETS: Record<string, number> = { minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 32768 };
const CLAUDE_OUTPUT_HEADROOM = 1024;
const QUOTA_WINDOW_SECONDS = 0;

export function antigravityHeaders(): Record<string, string> {
  return { "User-Agent": `antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} linux/amd64` };
}

function without(node: JsonMap, ...keys: string[]): JsonMap {
  const copy = { ...node };
  for (const key of keys) delete copy[key];
  return copy;
}

function mergeSchemas(base: JsonMap, extra: JsonMap): JsonMap {
  const merged: JsonMap = { ...base, ...extra };
  const properties = { ...(asRecord(base.properties) ?? {}), ...(asRecord(extra.properties) ?? {}) };
  if (Object.keys(properties).length) merged.properties = properties;
  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(extra.required) ? extra.required : []),
  ];
  if (required.length) merged.required = [...new Set(required)];
  return merged;
}

function resolveRefs(node: JsonMap, defs: JsonMap): JsonMap {
  let current = node;
  for (let hop = 0; hop < MAX_SCHEMA_DEPTH && typeof current.$ref === "string"; hop++) {
    const target = asRecord(defs[current.$ref.split("/").pop() ?? ""]);
    current = { ...(target ?? {}), ...without(current, "$ref") };
  }
  return without(current, "$ref");
}

function cleanSchema(value: unknown, defs: JsonMap, depth: number): JsonMap {
  if (depth > MAX_SCHEMA_DEPTH) return { type: "string" };
  let node = resolveRefs(asRecord(value) ?? {}, defs);
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    node = mergeSchemas(node, resolveRefs(asRecord(part) ?? {}, defs));
  }
  const variants = [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : []),
  ].filter((variant) => asRecord(variant)?.type !== "null");
  if (variants.length) {
    node = mergeSchemas(resolveRefs(asRecord(variants[0]) ?? {}, defs), without(node, "anyOf", "oneOf", "allOf"));
  }
  if ("const" in node && !("enum" in node)) node = { ...node, enum: [node.const] };
  const types = Array.isArray(node.type) ? node.type.map(String) : [];
  if (types.length) node = { ...node, type: types.find((type) => type !== "null") ?? "string" };
  const hints = CONSTRAINT_KEYS.filter((key) => node[key] !== undefined).map((key) => `${key}: ${String(node[key])}`);
  const out: JsonMap = {};
  for (const key of SCHEMA_KEYS) if (node[key] !== undefined) out[key] = node[key];
  const description = [asString(node.description), hints.length ? `(${hints.join(", ")})` : ""].filter(Boolean).join(" ");
  if (description) out.description = description;
  else delete out.description;
  if (Array.isArray(out.enum)) out.enum = out.enum.map(String);
  const properties = asRecord(out.properties);
  if (properties) {
    const cleaned: JsonMap = {};
    for (const [name, child] of Object.entries(properties)) cleaned[name] = cleanSchema(child, defs, depth + 1);
    out.properties = cleaned;
    if (Array.isArray(out.required)) out.required = out.required.filter((name) => typeof name === "string" && name in cleaned);
    if (Array.isArray(out.required) && !out.required.length) delete out.required;
    if (!out.type) out.type = "object";
  }
  if (out.type === "array") out.items = cleanSchema(out.items ?? { type: "string" }, defs, depth + 1);
  return out;
}

export function geminiSchema(schema: unknown): JsonMap {
  const root = asRecord(schema) ?? {};
  const defs = { ...(asRecord(root.definitions) ?? {}), ...(asRecord(root.$defs) ?? {}) };
  return cleanSchema(root, defs, 0);
}

function functionDeclarations(tools: unknown): JsonMap[] {
  const out: JsonMap[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = asRecord(raw);
    const fn = asRecord(tool?.function);
    if (tool?.type !== "function" || typeof fn?.name !== "string") continue;
    const declaration: JsonMap = { name: fn.name };
    if (typeof fn.description === "string" && fn.description) declaration.description = fn.description;
    const parameters = geminiSchema(fn.parameters);
    if (asRecord(parameters.properties) && Object.keys(asRecord(parameters.properties) ?? {}).length) {
      declaration.parameters = parameters;
    }
    out.push(declaration);
  }
  return out;
}

function toolConfig(choice: unknown): JsonMap | null {
  if (typeof choice === "string") {
    const mode = { none: "NONE", auto: "AUTO", required: "ANY" }[choice];
    return mode ? { functionCallingConfig: { mode } } : null;
  }
  const name = asString(asRecord(asRecord(choice)?.function)?.name);
  return name ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } } : null;
}

function imagePart(url: string): JsonMap {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (!match) {
    throw new GateError(400, "unsupported_parameter", "antigravity accepts images only as base64 data URLs", {
      param: "messages",
    });
  }
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function userParts(content: unknown): JsonMap[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: JsonMap[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "text" || part.type === "input_text") {
      const text = asString(part.text);
      if (text) parts.push({ text });
    } else if (part.type === "image_url") {
      const image = asRecord(part.image_url);
      parts.push(imagePart(typeof part.image_url === "string" ? part.image_url : asString(image?.url)));
    } else {
      throw new GateError(400, "unsupported_parameter", `antigravity does not support ${asString(part.type, "this")} content parts`, {
        param: "messages",
      });
    }
  }
  return parts;
}

function parsedArguments(value: unknown): JsonMap {
  if (typeof value !== "string") return asRecord(value) ?? {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function assistantParts(message: JsonMap, names: Map<string, string>): JsonMap[] {
  const parts = userParts(message.content);
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    const name = asString(fn?.name);
    if (!name) continue;
    const id = asString(call?.id);
    if (id) names.set(id, name);
    parts.push({
      functionCall: { ...(id ? { id } : {}), name, args: parsedArguments(fn?.arguments) },
      thoughtSignature: SKIP_THOUGHT_SIGNATURE,
    });
  }
  return parts;
}

function toolResultPart(message: JsonMap, names: Map<string, string>): JsonMap {
  const id = asString(message.tool_call_id);
  return {
    functionResponse: {
      ...(id ? { id } : {}),
      name: names.get(id) || asString(message.name) || "tool",
      response: { result: stringifyContent(message.content) },
    },
  };
}

function appendContent(contents: JsonMap[], role: string, parts: JsonMap[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role && Array.isArray(last.parts)) last.parts = [...last.parts, ...parts];
  else contents.push({ role, parts });
}

export function isClaudeModel(model: string): boolean {
  return model.toLowerCase().startsWith("claude");
}

function stopSequences(stop: unknown): string[] {
  const list = Array.isArray(stop) ? stop : [stop];
  return list.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function thinkingConfig(model: string, effort: string, maxOutput: number): JsonMap | null {
  if (!effort || effort === "none") return null;
  if (/^gemini-3/i.test(model)) {
    return { includeThoughts: true, thinkingLevel: ["high", "xhigh", "max"].includes(effort) ? "high" : "low" };
  }
  const budget = (isClaudeModel(model) ? CLAUDE_THINKING_BUDGETS : GEMINI_BUDGETS)[effort];
  if (!budget || (maxOutput > 0 && maxOutput <= budget)) return null;
  return { includeThoughts: true, thinkingBudget: budget };
}

function generationConfig(body: JsonMap, model: string): JsonMap {
  const config: JsonMap = {};
  if (typeof body.temperature === "number") config.temperature = body.temperature;
  if (typeof body.top_p === "number") config.topP = body.top_p;
  const stops = stopSequences(body.stop);
  if (stops.length) config.stopSequences = stops;
  const maxOutput = asNumber(body.max_completion_tokens, asNumber(body.max_tokens, 0));
  if (maxOutput > 0 && isClaudeModel(model)) config.maxOutputTokens = maxOutput;
  const format = asRecord(body.response_format);
  if (format?.type === "json_object") config.responseMimeType = "application/json";
  const schema = asRecord(asRecord(format?.json_schema)?.schema);
  if (format?.type === "json_schema" && schema) {
    config.responseMimeType = "application/json";
    config.responseSchema = geminiSchema(schema);
  }
  const effort = asString(body.reasoning_effort) || asString(asRecord(body.reasoning)?.effort);
  const thinking = thinkingConfig(model, effort, maxOutput);
  if (thinking) {
    config.thinkingConfig = thinking;
    const budget = asNumber(thinking.thinkingBudget, 0);
    if (isClaudeModel(model) && budget > 0 && asNumber(config.maxOutputTokens, 0) === 0) {
      config.maxOutputTokens = budget + CLAUDE_OUTPUT_HEADROOM;
    }
  }
  return config;
}

export function chatToAntigravity(body: JsonMap): JsonMap {
  const model = asString(body.model);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(asRecord)
    .filter((message): message is JsonMap => message !== null);
  const system = messages
    .filter((message) => INSTRUCTION_ROLES.has(asString(message.role)))
    .map((message) => stringifyContent(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const names = new Map<string, string>();
  const contents: JsonMap[] = [];
  for (const message of messages) {
    const role = asString(message.role);
    if (INSTRUCTION_ROLES.has(role)) continue;
    if (role === "assistant") appendContent(contents, "model", assistantParts(message, names));
    else if (role === "tool") appendContent(contents, "user", [toolResultPart(message, names)]);
    else appendContent(contents, "user", userParts(message.content));
  }
  const request: JsonMap = { contents };
  if (system) request.systemInstruction = { role: "user", parts: [{ text: system }] };
  const declarations = functionDeclarations(body.tools);
  if (declarations.length) {
    request.tools = [{ functionDeclarations: declarations }];
    const config = toolConfig(body.tool_choice);
    if (config) request.toolConfig = config;
  }
  const generation = generationConfig(body, model);
  if (Object.keys(generation).length) request.generationConfig = generation;
  return { model, request };
}

export function withProject(dep: ResolvedDeployment, auth: UpstreamAuth, payload: JsonMap): JsonMap {
  if (dep.kind !== "antigravity") return payload;
  const model = asString(payload.model);
  return {
    project: auth.project ?? "",
    model,
    requestType: model.includes("image") ? "image_gen" : "agent",
    userAgent: "antigravity",
    requestId: `agent-${newId()}`,
    request: payload.request,
  };
}

export function antigravityUsage(usage: JsonMap | null): JsonMap {
  const prompt = asNumber(usage?.promptTokenCount, 0);
  const thoughts = asNumber(usage?.thoughtsTokenCount, 0);
  const completion = asNumber(usage?.candidatesTokenCount, 0) + thoughts;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(usage?.totalTokenCount, prompt + completion),
    prompt_tokens_details: { cached_tokens: asNumber(usage?.cachedContentTokenCount, 0) },
    completion_tokens_details: { reasoning_tokens: thoughts },
  };
}

export function googleDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || !match[0]) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return Number.isFinite(seconds) ? seconds : null;
}

export function googleRetryAt(error: unknown, now = Date.now()): number | null {
  const details = asRecord(error)?.details;
  for (const raw of Array.isArray(details) ? details : []) {
    const detail = asRecord(raw);
    const metadata = asRecord(detail?.metadata);
    const stamp = Date.parse(asString(metadata?.quotaResetTimeStamp));
    if (Number.isFinite(stamp) && stamp > now) return stamp;
    const delay = googleDurationSeconds(metadata?.quotaResetDelay) ?? googleDurationSeconds(detail?.retryDelay);
    if (delay !== null && delay > 0) return now + delay * 1000;
  }
  return null;
}

function streamError(error: JsonMap): GateError {
  const status = asNumber(error.code, 502);
  return new GateError(status >= 400 && status < 600 ? status : 502, "upstream_error", asString(error.message) || "upstream response failed", {
    retryAt: googleRetryAt(error),
  });
}

export class AntigravitySseTranslator implements ChatSseTranslator {
  private id = `chatcmpl_${newId()}`;
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  private tools = 0;
  private usage: JsonMap | null = null;
  private finished = false;

  constructor(private model: string) {}

  pushLine(raw: string): string[] {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return [];
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return [];
    let parsed: JsonMap | null;
    try {
      parsed = asRecord(JSON.parse(payload));
    } catch {
      return [];
    }
    return parsed ? this.translate(parsed) : [];
  }

  flush(): string | null {
    return null;
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

  private finish(reason: string): string {
    const finish = this.tools > 0 ? "tool_calls" : reason === "MAX_TOKENS" ? "length" : CONTENT_FILTER_REASONS.has(reason) ? "content_filter" : "stop";
    return this.chunk({}, finish, antigravityUsage(this.usage));
  }

  private translate(parsed: JsonMap): string[] {
    const error = asRecord(parsed.error);
    if (error) throw streamError(error);
    const response = asRecord(parsed.response) ?? parsed;
    const usage = asRecord(response.usageMetadata);
    if (usage) this.usage = usage;
    const candidate = asRecord((Array.isArray(response.candidates) ? response.candidates : [])[0]);
    const parts = asRecord(candidate?.content)?.parts;
    const out: string[] = [];
    for (const raw of Array.isArray(parts) ? parts : []) {
      const part = asRecord(raw);
      if (!part) continue;
      const call = asRecord(part.functionCall);
      if (call) {
        const id = asString(call.id) || `call_${newId()}`;
        out.push(
          this.chunk({
            tool_calls: [
              {
                index: this.tools++,
                id,
                type: "function",
                function: { name: asString(call.name), arguments: JSON.stringify(call.args ?? {}) },
              },
            ],
          }),
        );
        continue;
      }
      const text = asString(part.text);
      if (!text) continue;
      out.push(this.chunk(part.thought === true ? { reasoning_content: text } : { content: text }));
    }
    const reason = asString(candidate?.finishReason);
    if (reason && !this.finished) {
      this.finished = true;
      out.push(this.finish(reason));
    }
    return out;
  }
}

export function antigravityCompletion(text: string, model: string): JsonMap {
  return completionFromSse(new AntigravitySseTranslator(model), text, model);
}

export function antigravityProject(json: unknown): string {
  const rec = asRecord(json);
  const project = rec?.cloudaicompanionProject;
  return typeof project === "string" ? project : asString(asRecord(project)?.id);
}

export function antigravityTier(json: unknown): { id: string; onboardId: string } {
  const rec = asRecord(json);
  const paid = asRecord(rec?.paidTier);
  const current = asRecord(rec?.currentTier);
  const tiers = Array.isArray(rec?.allowedTiers) ? rec.allowedTiers.map(asRecord) : [];
  const fallback = tiers.find((tier) => tier?.isDefault === true);
  return {
    id: asString(paid?.id) || asString(current?.id),
    onboardId: asString(fallback?.id) || asString(current?.id) || "free-tier",
  };
}

export function antigravityPlan(tierId: string): string {
  if (!tierId) return "";
  if (/ultra/i.test(tierId)) return "ultra";
  if (/pro|standard|g1/i.test(tierId)) return "pro";
  if (/free/i.test(tierId)) return "free";
  return tierId;
}

export function antigravityModels(json: unknown): DiscoveredModel[] {
  const models = asRecord(asRecord(json)?.models) ?? {};
  const out: DiscoveredModel[] = [];
  for (const [id, raw] of Object.entries(models)) {
    const model = asRecord(raw);
    if (!model) continue;
    out.push({
      id,
      name: asString(model.displayName) || id,
      ownedBy: isClaudeModel(id) ? "anthropic" : id.startsWith("gemini") ? "google" : "antigravity",
      contextLength: asNumber(model.maxTokens, 0),
      costInputPer1k: 0,
      costOutputPer1k: 0,
      priceSource: "none",
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function antigravityLimits(json: unknown, plan: string, now = Date.now()): SubscriptionLimits {
  const models = asRecord(asRecord(json)?.models) ?? {};
  const windows: LimitWindow[] = [];
  for (const [id, raw] of Object.entries(models)) {
    const quota = asRecord(asRecord(raw)?.quotaInfo);
    if (!quota) continue;
    const resetsAt = asString(quota.resetTime);
    const remaining = quota.remainingFraction;
    const exhausted = typeof remaining !== "number" && resetsAt !== "";
    const fraction = typeof remaining === "number" ? Math.min(1, Math.max(0, remaining)) : exhausted ? 0 : 1;
    const usedPercent = Math.round((1 - fraction) * 1000) / 10;
    const reset = Date.parse(resetsAt);
    windows.push({
      scope: id,
      usedPercent,
      windowSeconds: QUOTA_WINDOW_SECONDS,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      limitReached: usedPercent >= 100,
    });
  }
  windows.sort((a, b) => a.scope.localeCompare(b.scope));
  return { plan, windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: new Date(now).toISOString() };
}
