import { asRecord, newId } from "@/lib/gateway/core";
import type { DataUrl } from "@/types/anthropic";
import type { JsonMap } from "@/types/gateway";

const DEFAULT_MAX_TOKENS = 4096;
const COUNT_TOKENS_KEYS = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "cache_control",
];
const GATEWAY_ONLY_KEYS = ["tags", "tag", "user", "fallbacks", "fallback"];
const MIN_THINKING_BUDGET = 1024;
const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const XHIGH_MIN_VERSION = 4.7;
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16384,
};

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseDataUrl(url: string): DataUrl | null {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,([\s\S]*)$/.exec(url.trim());
  if (!match?.[1] || !match[2]) return null;
  return { mediaType: match[1], data: match[2] };
}

function imageBlockFromUrl(url: string): JsonMap | null {
  const parsed = parseDataUrl(url);
  if (parsed) {
    return {
      type: "image",
      source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
    };
  }
  if (/^https?:\/\//i.test(url.trim())) {
    return { type: "image", source: { type: "url", url: url.trim() } };
  }
  return null;
}

export function parseToolInput(value: unknown): JsonMap {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function finishFromStopReason(reason: unknown): string {
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

export function chatUsageFromAnthropic(usage: JsonMap | null | undefined): JsonMap {
  const read = count(usage?.cache_read_input_tokens);
  const created = count(usage?.cache_creation_input_tokens);
  const prompt = count(usage?.input_tokens) + read + created;
  const completion = count(usage?.output_tokens);
  const thinking = count(asRecord(usage?.output_tokens_details)?.thinking_tokens);
  const out: JsonMap = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: read },
  };
  if (thinking) out.completion_tokens_details = { reasoning_tokens: thinking };
  if (read) out.cache_read_input_tokens = read;
  if (created) out.cache_creation_input_tokens = created;
  const creation = asRecord(usage?.cache_creation);
  if (creation) out.cache_creation = creation;
  for (const key of ["service_tier", "speed", "inference_geo"]) {
    if (typeof usage?.[key] === "string") out[key] = usage[key];
  }
  return out;
}

export function claudeVersion(model: unknown): number | null {
  if (typeof model !== "string") return null;
  const match = /claude-(?:[a-z]+-)*?(\d+)(?:[-.](\d))?(?=[-.@:[]|$)/.exec(model.toLowerCase());
  if (!match?.[1]) return null;
  return Number(match[1]) + Number(match[2] ?? 0) / 10;
}

function fixedSampling(model: unknown): boolean {
  const version = claudeVersion(model);
  if (version !== null) return version >= 4.7;
  return typeof model === "string" && /claude-(mythos|fable)/i.test(model);
}

function thinkingBlocks(value: unknown): JsonMap[] {
  if (!Array.isArray(value)) return [];
  const out: JsonMap[] = [];
  for (const raw of value) {
    const block = asRecord(raw);
    if (block?.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
      out.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
      out.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return out;
}

function reasoningConfig(
  model: unknown,
  effort: unknown,
  maxTokens: number | null,
): { thinking?: JsonMap; effort?: string; maxTokens?: number } | null {
  if (typeof effort !== "string" || !effort) return null;
  const version = claudeVersion(model);
  if (version !== null && version < 4.6) {
    const budget = THINKING_BUDGETS[effort];
    if (!budget) return null;
    if (maxTokens === null) {
      return { thinking: { type: "enabled", budget_tokens: budget }, maxTokens: DEFAULT_MAX_TOKENS + budget };
    }
    const capped = Math.min(budget, maxTokens - 1);
    if (capped < MIN_THINKING_BUDGET) return null;
    return { thinking: { type: "enabled", budget_tokens: capped } };
  }
  if (effort === "none") return { effort: "low" };
  const requested = effort === "minimal" ? "low" : effort;
  const level = requested === "xhigh" && version !== null && version < XHIGH_MIN_VERSION ? "high" : requested;
  if (!ANTHROPIC_EFFORTS.has(level)) return null;
  return { thinking: { type: "adaptive" }, effort: level };
}

function outputFormat(format: unknown): JsonMap | null {
  const rec = asRecord(format);
  if (rec?.type !== "json_schema") return null;
  const schema = asRecord(asRecord(rec.json_schema)?.schema);
  return schema ? { type: "json_schema", schema } : null;
}

function withCache(block: JsonMap, source: JsonMap): JsonMap {
  const cache = asRecord(source.cache_control);
  return cache ? { ...block, cache_control: cache } : block;
}

function textBlocks(content: unknown): JsonMap[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: JsonMap[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) out.push({ type: "text", text: part });
      continue;
    }
    const rec = asRecord(part);
    if (!rec) continue;
    const text =
      typeof rec.text === "string"
        ? rec.text
        : typeof rec.refusal === "string"
          ? rec.refusal
          : "";
    if (text) out.push(withCache({ type: "text", text }, rec));
  }
  return out;
}

function fileBlock(part: JsonMap): JsonMap | null {
  const file = asRecord(part.file);
  const data = typeof file?.file_data === "string" ? parseDataUrl(file.file_data) : null;
  if (!data || data.mediaType !== "application/pdf") return null;
  const block: JsonMap = {
    type: "document",
    source: { type: "base64", media_type: data.mediaType, data: data.data },
  };
  if (typeof file?.filename === "string" && file.filename) block.title = file.filename;
  return withCache(block, part);
}

function contentBlocks(content: unknown): JsonMap[] {
  if (!Array.isArray(content)) return textBlocks(content);
  const out: JsonMap[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) {
      out.push(...textBlocks([part]));
      continue;
    }
    if (rec.type === "image_url" || rec.type === "input_image") {
      const ref = rec.image_url;
      const url = typeof ref === "string" ? ref : asRecord(ref)?.url;
      const block = typeof url === "string" ? imageBlockFromUrl(url) : null;
      if (block) out.push(withCache(block, rec));
      continue;
    }
    if (rec.type === "file") {
      const block = fileBlock(rec);
      if (block) out.push(block);
      continue;
    }
    out.push(...textBlocks([rec]));
  }
  return out;
}

function toolResultBlock(message: JsonMap): JsonMap {
  const block: JsonMap = {
    type: "tool_result",
    tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
  };
  const content = message.content;
  if (typeof content === "string" && content) block.content = content;
  if (Array.isArray(content)) {
    const blocks = contentBlocks(content);
    if (blocks.length) block.content = blocks;
  }
  return block;
}

function assistantBlocks(message: JsonMap): JsonMap[] {
  const out = [...thinkingBlocks(message.thinking_blocks), ...textBlocks(message.content)];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || typeof fn?.name !== "string") continue;
    out.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `toolu_${newId()}`,
      name: fn.name,
      input: parseToolInput(fn.arguments),
    });
  }
  return out;
}

function anthropicTools(tools: unknown): JsonMap[] {
  if (!Array.isArray(tools)) return [];
  const out: JsonMap[] = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    if (!tool) continue;
    const fn = asRecord(tool.function);
    if (fn && typeof fn.name === "string") {
      const converted: JsonMap = {
        name: fn.name,
        input_schema: { type: "object", ...(asRecord(fn.parameters) ?? {}) },
      };
      if (typeof fn.description === "string" && fn.description) {
        converted.description = fn.description;
      }
      if (fn.strict === true) converted.strict = true;
      out.push(withCache(converted, tool));
      continue;
    }
    if (typeof tool.name === "string" && asRecord(tool.input_schema)) out.push(tool);
  }
  return out;
}

function anthropicToolChoice(choice: unknown, parallel: unknown): JsonMap | null {
  let out: JsonMap | null = null;
  if (choice === "none") return { type: "none" };
  if (choice === "required") out = { type: "any" };
  else if (choice === "auto") out = { type: "auto" };
  else {
    const rec = asRecord(choice);
    const name = asRecord(rec?.function)?.name ?? rec?.name;
    if (typeof name === "string" && name) out = { type: "tool", name };
  }
  if (parallel === false) out = { ...(out ?? { type: "auto" }), disable_parallel_tool_use: true };
  return out;
}

function stopSequences(body: JsonMap): string[] {
  const out: string[] = [];
  for (const value of [body.stop, body.stop_sequences]) {
    if (typeof value === "string" && value) out.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item) out.push(item);
    }
  }
  return out;
}

export function chatToAnthropic(body: JsonMap): JsonMap {
  const system: JsonMap[] = textBlocks(
    typeof body.system === "string" || Array.isArray(body.system) ? body.system : "",
  );
  const turns: { role: "user" | "assistant"; content: JsonMap[] }[] = [];
  const add = (role: "user" | "assistant", blocks: JsonMap[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const item of messages) {
    const rec = asRecord(item);
    if (!rec) continue;
    const role = typeof rec.role === "string" ? rec.role : "user";
    if (role === "system" || role === "developer") system.push(...textBlocks(rec.content));
    else if (role === "tool") add("user", [toolResultBlock(rec)]);
    else if (role === "assistant") add("assistant", assistantBlocks(rec));
    else add("user", contentBlocks(rec.content));
  }
  const requestedMax =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : null;
  const native = asRecord(body.thinking);
  const reasoning = native ? null : reasoningConfig(body.model, body.reasoning_effort, requestedMax);
  const out: JsonMap = {
    model: body.model,
    messages: turns.map((turn) => ({
      role: turn.role,
      content:
        turn.role === "user"
          ? [
              ...turn.content.filter((block) => block.type === "tool_result"),
              ...turn.content.filter((block) => block.type !== "tool_result"),
            ]
          : turn.content,
    })),
    max_tokens: reasoning?.maxTokens ?? requestedMax ?? DEFAULT_MAX_TOKENS,
  };
  if (system.length) {
    out.system = system.some((block) => block.cache_control)
      ? system
      : system.map((block) => block.text).join("\n");
  }
  const thinking = native ?? reasoning?.thinking ?? null;
  const thinkingOn = thinking !== null && thinking.type !== "disabled";
  if (!fixedSampling(body.model)) {
    if (thinkingOn) {
      if (typeof body.top_p === "number" && body.top_p >= 0.95) out.top_p = body.top_p;
    } else {
      if (typeof body.temperature === "number") {
        out.temperature = Math.min(1, Math.max(0, body.temperature));
      } else if (typeof body.top_p === "number") {
        out.top_p = body.top_p;
      }
      if (typeof body.top_k === "number") out.top_k = body.top_k;
    }
  }
  if (thinking) out.thinking = thinking;
  const outputConfig: JsonMap = { ...(asRecord(body.output_config) ?? {}) };
  if (reasoning?.effort && outputConfig.effort === undefined) outputConfig.effort = reasoning.effort;
  const format = outputFormat(body.response_format);
  if (format && outputConfig.format === undefined) outputConfig.format = format;
  if (Object.keys(outputConfig).length) out.output_config = outputConfig;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  const stops = stopSequences(body);
  if (stops.length) out.stop_sequences = stops;
  const tools = anthropicTools(body.tools);
  if (tools.length) {
    out.tools = tools;
    const choice = anthropicToolChoice(body.tool_choice, body.parallel_tool_calls);
    if (choice) out.tool_choice = choice;
  }
  const meta = asRecord(body.metadata);
  const userId =
    typeof meta?.user_id === "string" ? meta.user_id : typeof body.user === "string" ? body.user : "";
  if (userId) out.metadata = { user_id: userId };
  return out;
}

export function anthropicToChat(json: JsonMap, model: string): JsonMap {
  let text = "";
  let reasoning = "";
  const toolCalls: JsonMap[] = [];
  const content = Array.isArray(json.content) ? json.content : [];
  const thinking = thinkingBlocks(content);
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning += block.thinking;
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${newId()}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(asRecord(block.input) ?? {}),
        },
      });
      continue;
    }
    if ((block.type === "text" || block.type === undefined) && typeof block.text === "string") {
      text += block.text;
    }
  }
  const message: JsonMap = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (thinking.length) message.thinking_blocks = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const choice: JsonMap = {
    index: 0,
    message,
    logprobs: null,
    finish_reason: finishFromStopReason(json.stop_reason),
  };
  if (json.stop_reason === "stop_sequence" && typeof json.stop_sequence === "string") {
    choice.stop_reason = json.stop_sequence;
  }
  return {
    id: typeof json.id === "string" ? json.id : `chatcmpl_${newId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
    usage: chatUsageFromAnthropic(asRecord(json.usage)),
  };
}

export class AnthropicSseTranslator {
  private event = "";
  private data = "";
  private id = `chatcmpl_${newId()}`;
  private created = Math.floor(Date.now() / 1000);
  private usage: JsonMap = {};
  private toolSlots = new Map<number, number>();
  private toolCount = 0;
  private thinking = new Map<number, { thinking: string; signature: string }>();

  constructor(private model: string) {}

  pushLine(raw: string): string[] {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) {
      const flushed = this.flush();
      return flushed ? [flushed] : [];
    }
    if (line.startsWith(":")) return [];
    if (line.startsWith("event:")) {
      const pending = this.data ? this.flush() : null;
      this.event = line.slice(6).trim();
      return pending ? [pending] : [];
    }
    if (line.startsWith("data:")) {
      if (this.data) this.data += "\n";
      this.data += line.slice(5).trim();
    }
    return [];
  }

  flush(): string | null {
    const payload = this.data.trim();
    const event = this.event;
    this.data = "";
    this.event = "";
    if (!payload) return null;
    let parsed: JsonMap;
    try {
      parsed = JSON.parse(payload) as JsonMap;
    } catch {
      return null;
    }
    return this.translate(event || (typeof parsed.type === "string" ? parsed.type : ""), parsed);
  }

  private chunk(delta: JsonMap): string {
    return JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
    });
  }

  private translate(event: string, data: JsonMap): string | null {
    if (event === "error") {
      const err = asRecord(data.error);
      const message =
        typeof err?.message === "string"
          ? err.message
          : typeof data.error === "string"
            ? data.error
            : JSON.stringify(data);
      throw new Error(message);
    }
    if (event === "message_start") {
      const message = asRecord(data.message);
      if (typeof message?.id === "string") this.id = message.id;
      this.usage = { ...(asRecord(message?.usage) ?? {}) };
      return this.chunk({ role: "assistant", content: "" });
    }
    if (event === "content_block_start") {
      const block = asRecord(data.content_block);
      if (block?.type === "tool_use") {
        const slot = this.toolCount++;
        this.toolSlots.set(Number(data.index ?? 0), slot);
        return this.chunk({
          tool_calls: [
            {
              index: slot,
              id: typeof block.id === "string" ? block.id : `call_${newId()}`,
              type: "function",
              function: { name: typeof block.name === "string" ? block.name : "", arguments: "" },
            },
          ],
        });
      }
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        return this.chunk({ content: block.text });
      }
      if (block?.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        this.thinking.set(Number(data.index ?? 0), {
          thinking: text,
          signature: typeof block.signature === "string" ? block.signature : "",
        });
        return text ? this.chunk({ reasoning_content: text }) : null;
      }
      if (block?.type === "redacted_thinking" && typeof block.data === "string") {
        return this.chunk({ thinking_blocks: [{ type: "redacted_thinking", data: block.data }] });
      }
      return null;
    }
    if (event === "content_block_stop") {
      const index = Number(data.index ?? 0);
      const done = this.thinking.get(index);
      if (!done) return null;
      this.thinking.delete(index);
      return this.chunk({ thinking_blocks: [{ type: "thinking", thinking: done.thinking, signature: done.signature }] });
    }
    if (event === "content_block_delta") {
      const delta = asRecord(data.delta);
      if (delta?.type === "input_json_delta") {
        const slot = this.toolSlots.get(Number(data.index ?? 0));
        const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
        if (slot === undefined || !partial) return null;
        return this.chunk({ tool_calls: [{ index: slot, function: { arguments: partial } }] });
      }
      if (delta?.type === "thinking_delta" || delta?.type === "signature_delta") {
        const slot = this.thinking.get(Number(data.index ?? 0));
        if (delta.type === "signature_delta") {
          if (slot && typeof delta.signature === "string") slot.signature += delta.signature;
          return null;
        }
        const piece = typeof delta.thinking === "string" ? delta.thinking : "";
        if (slot) slot.thinking += piece;
        return piece ? this.chunk({ reasoning_content: piece }) : null;
      }
      const text = typeof delta?.text === "string" ? delta.text : "";
      return text ? this.chunk({ content: text }) : null;
    }
    if (event === "message_delta") {
      const delta = asRecord(data.delta);
      const usage = asRecord(data.usage);
      for (const [key, value] of Object.entries(usage ?? {})) {
        if (typeof value === "number" && (key === "output_tokens" || value > 0)) {
          this.usage[key] = value;
        }
      }
      const choice: JsonMap = {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: finishFromStopReason(delta?.stop_reason),
      };
      if (delta?.stop_reason === "stop_sequence" && typeof delta.stop_sequence === "string") {
        choice.stop_reason = delta.stop_sequence;
      }
      return JSON.stringify({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [choice],
        usage: chatUsageFromAnthropic(this.usage),
      });
    }
    return null;
  }
}

export function anthropicCountBody(body: JsonMap): JsonMap {
  const out: JsonMap = {};
  for (const key of COUNT_TOKENS_KEYS) {
    if (body[key] !== undefined && body[key] !== null) out[key] = body[key];
  }
  return out;
}

export function nativeMessagesBody(body: JsonMap): JsonMap {
  const out: JsonMap = { ...body };
  for (const key of GATEWAY_ONLY_KEYS) delete out[key];
  const meta = asRecord(out.metadata);
  if (meta) {
    if (typeof meta.user_id === "string" && meta.user_id) out.metadata = { user_id: meta.user_id };
    else delete out.metadata;
  }
  return out;
}
