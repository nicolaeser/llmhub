import "server-only";
import { admit } from "@/lib/gateway/access/gate";
import { dispatchChat, streamChat } from "@/lib/gateway/dispatch/chat";
import { asRecord, newId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { SSE_HEADERS, sseData } from "@/lib/gateway/protocols/sse";
import { addChatUsage, assistantMessage } from "@/lib/rag/file-search-tool";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { cancelQuietly } from "@/lib/utils/streams";
import { parseJsonOrNull } from "@/lib/utils/json";
import { MCP_REQUEST_TIMEOUT_MS } from "@/lib/mcp/client";
import { mcpErrorCode } from "@/lib/mcp/errors";
import { screenToolResult, traceStep } from "@/lib/mcp/screen";
import { isMcpToolName } from "@/lib/mcp/tool-names";
import type { JsonMap } from "@/types/gateway";
import type {
  McpBoundTool,
  McpCallRecord,
  McpChatRun,
  McpLoopContext,
  McpStreamSink,
  McpStreamSlot,
  McpToolCall,
  McpToolOutcome,
  McpToolset,
} from "@/types/mcp";

export const MCP_MAX_STEPS = 8;
export const MCP_TOOL_BUDGET_MS = 180_000;
export const MCP_MAX_CALLS_PER_STEP = 16;

const MAX_DESCRIPTION = 1_024;

function functionName(value: unknown): string {
  const rec = asRecord(value);
  const name = asRecord(rec?.function)?.name ?? rec?.name;
  return typeof name === "string" ? name : "";
}

export function toolDescription(bound: McpBoundTool): string {
  const text = bound.tool.description || bound.tool.title || bound.tool.name;
  return `${text} (MCP server ${bound.serverName})`.slice(0, MAX_DESCRIPTION);
}

export function chatToolNames(body: JsonMap): string[] {
  return (Array.isArray(body.tools) ? body.tools : []).map(functionName).filter(Boolean);
}

export function withMcpTools(body: JsonMap, toolset: McpToolset): JsonMap {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    ...body,
    tools: [
      ...tools,
      ...toolset.tools.map((bound) => ({
        type: "function",
        function: { name: bound.name, description: toolDescription(bound), parameters: bound.tool.inputSchema },
      })),
    ],
  };
}

function forcesTool(choice: unknown, toolset: McpToolset): boolean {
  return choice === "required" || toolset.byName.has(functionName(choice));
}

export function stepBody(base: JsonMap, transcript: JsonMap[], step: number, last: boolean, toolset: McpToolset): JsonMap {
  const messages = Array.isArray(base.messages) ? base.messages : [];
  const next: JsonMap = { ...base, messages: [...messages, ...transcript] };
  if (step > 0 && forcesTool(next.tool_choice, toolset)) next.tool_choice = "auto";
  if (!last) return next;
  const tools = (Array.isArray(next.tools) ? next.tools : []).filter((tool) => !toolset.byName.has(functionName(tool)));
  if (tools.length) {
    next.tools = tools;
    if (forcesTool(next.tool_choice, toolset)) next.tool_choice = "auto";
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

export function withoutMcpHistory(messages: JsonMap[], keep: ReadonlySet<string>): JsonMap[] {
  const dropped = new Set<string>();
  const out: JsonMap[] = [];
  const foreign = (call: unknown) => isMcpToolName(functionName(call)) && !keep.has(functionName(call));
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string" && dropped.has(message.tool_call_id)) continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (message.role !== "assistant" || !calls.some(foreign)) {
      out.push(message);
      continue;
    }
    for (const call of calls.filter(foreign)) {
      const id = asRecord(call)?.id;
      if (typeof id === "string") dropped.add(id);
    }
    const rest = calls.filter((call) => !foreign(call));
    const copy: JsonMap = { ...message };
    if (rest.length) copy.tool_calls = rest;
    else delete copy.tool_calls;
    if (rest.length || (typeof copy.content === "string" && copy.content) || Array.isArray(copy.content)) out.push(copy);
  }
  return out;
}

function firstChoice(chat: JsonMap): JsonMap {
  return asRecord(Array.isArray(chat.choices) ? chat.choices[0] : null) ?? {};
}

function firstMessage(chat: JsonMap): JsonMap {
  return asRecord(firstChoice(chat).message) ?? {};
}

export function toolCallsOf(message: JsonMap): McpToolCall[] {
  return (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((raw) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || typeof fn?.name !== "string") return [];
    return [
      {
        id: typeof call.id === "string" && call.id ? call.id : `call_${newId()}`,
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    ];
  });
}

function parseArguments(text: string): JsonMap | null {
  if (!text.trim()) return {};
  return asRecord(parseJsonOrNull(text));
}

async function runTool(ctx: McpLoopContext, call: McpToolCall, deadline: number): Promise<McpToolOutcome> {
  const bound = ctx.toolset.byName.get(call.name);
  if (!bound) return { text: "This tool is not available.", isError: true };
  const args = parseArguments(call.arguments);
  if (!args) return { text: "Invalid tool arguments: expected a JSON object.", isError: true };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { text: "Skipped: the gateway's tool time limit was reached.", isError: true };
  const signals = [AbortSignal.timeout(Math.min(MCP_REQUEST_TIMEOUT_MS, remaining))];
  if (ctx.signal) signals.push(ctx.signal);
  const started = Date.now();
  try {
    const outcome = await ctx.toolset.executor.call(bound, args, AbortSignal.any(signals));
    logger.info("mcp.tool_call", {
      serverId: bound.serverId,
      tool: bound.tool.name,
      ms: Date.now() - started,
      ok: !outcome.isError,
    });
    return outcome;
  } catch (err) {
    const code = mcpErrorCode(err);
    logger.warn("mcp.tool_call", {
      serverId: bound.serverId,
      tool: bound.tool.name,
      ms: Date.now() - started,
      ok: false,
      code,
    });
    return { text: `The tool call failed (${code}).`, isError: true };
  }
}

export async function executeCalls(
  ctx: McpLoopContext,
  calls: McpToolCall[],
  request: JsonMap,
  deadline: number,
): Promise<McpCallRecord[]> {
  const outcomes = await Promise.all(
    calls.map((call, index) =>
      index < MCP_MAX_CALLS_PER_STEP
        ? runTool(ctx, call, deadline)
        : Promise.resolve({ text: "Skipped: too many tool calls in one step.", isError: true }),
    ),
  );
  const records: McpCallRecord[] = [];
  for (const [index, call] of calls.entries()) {
    const outcome = outcomes[index]!;
    const bound = ctx.toolset.byName.get(call.name)!;
    const text = outcome.isError ? `[tool error] ${outcome.text}` : outcome.text;
    records.push({ call, bound, outcome, content: await screenToolResult(ctx.principal, ctx.model, request, text) });
  }
  return records;
}

export function toolMessage(record: McpCallRecord): JsonMap {
  return { role: "tool", tool_call_id: record.call.id, content: record.content };
}

function withoutMcpCalls(chat: JsonMap, usage: JsonMap | null, toolset: McpToolset): JsonMap {
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  return {
    ...chat,
    usage,
    choices: choices.map((raw, index) => {
      const choice = asRecord(raw);
      if (!choice || index > 0) return raw;
      const message = { ...(asRecord(choice.message) ?? {}) };
      const all = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const kept = all.filter((call) => !toolset.byName.has(functionName(call)));
      if (kept.length === all.length) return choice;
      if (kept.length) message.tool_calls = kept;
      else delete message.tool_calls;
      const finish = !kept.length && choice.finish_reason === "tool_calls" ? "stop" : choice.finish_reason;
      return { ...choice, message, finish_reason: finish };
    }),
  };
}

function isLastStep(step: number, deadline: number): boolean {
  return step >= MCP_MAX_STEPS - 1 || Date.now() >= deadline;
}

export async function runMcpChat(ctx: McpLoopContext, body: JsonMap): Promise<McpChatRun> {
  const { toolset, principal } = ctx;
  const deadline = Date.now() + MCP_TOOL_BUDGET_MS;
  const transcript: JsonMap[] = [];
  const steps: McpChatRun["steps"] = [];
  let usage: JsonMap | null = null;
  try {
    for (let step = 0; ; step++) {
      const last = isLastStep(step, deadline);
      const request = stepBody(body, transcript, step, last, toolset);
      if (step > 0) {
        await admit(principal, ctx.maxCost);
        await traceStep(principal, request);
      }
      const { json } = await dispatchChat({
        principal,
        model: ctx.model,
        body: request,
        aliases: ctx.aliases,
        outputGuard: ctx.outputGuard,
      });
      usage = addChatUsage(usage, json.usage);
      const message = firstMessage(json);
      const calls = toolCallsOf(message);
      const mcp = calls.filter((call) => toolset.byName.has(call.name));
      const mixed = mcp.length < calls.length;
      if (!mcp.length || mixed || last || firstChoice(json).finish_reason === "content_filter") {
        const final = withoutMcpCalls(json, usage, toolset);
        const answer = firstMessage(final);
        transcript.push(assistantMessage(answer));
        steps.push({ message: answer, calls: [] });
        return { final, transcript, steps };
      }
      const records = await executeCalls(ctx, mcp, request, deadline);
      transcript.push(assistantMessage(message), ...records.map(toolMessage));
      steps.push({ message, calls: records });
    }
  } finally {
    await toolset.executor.close();
  }
}

class StreamRound {
  usage: JsonMap | null = null;
  finish: unknown = null;
  private content = "";
  private thinking: JsonMap[] = [];
  private slots = new Map<number, McpStreamSlot>();
  private nextOut = 0;

  constructor(private readonly toolset: McpToolset) {}

  private classify(slot: McpStreamSlot): JsonMap[] {
    if (slot.kind !== "pending" || !slot.name) return [];
    if (this.toolset.byName.has(slot.name)) {
      slot.kind = "mcp";
      slot.held = [];
      return [];
    }
    slot.kind = "caller";
    slot.out = this.nextOut++;
    const held = slot.held.map((delta) => ({ ...delta, index: slot.out }));
    slot.held = [];
    return held;
  }

  private toolDeltas(raw: unknown[]): JsonMap[] {
    const out: JsonMap[] = [];
    for (const [position, item] of raw.entries()) {
      const call = asRecord(item);
      if (!call) continue;
      const index = typeof call.index === "number" ? call.index : position;
      const fn = asRecord(call.function);
      const slot: McpStreamSlot = this.slots.get(index) ?? { id: "", name: "", arguments: "", kind: "pending", out: -1, held: [] };
      this.slots.set(index, slot);
      if (!slot.id && typeof call.id === "string") slot.id = call.id;
      if (!slot.name && typeof fn?.name === "string") slot.name = fn.name;
      if (typeof fn?.arguments === "string") slot.arguments += fn.arguments;
      if (slot.kind === "pending") {
        slot.held.push(call);
        out.push(...this.classify(slot));
      } else if (slot.kind === "caller") {
        out.push({ ...call, index: slot.out });
      }
    }
    return out;
  }

  take(chunk: JsonMap): JsonMap | null {
    if (asRecord(chunk.usage)) this.usage = asRecord(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const rest: JsonMap = { ...chunk };
    delete rest.usage;
    const choice = asRecord(choices.find((item) => Number(asRecord(item)?.index ?? 0) === 0));
    if (!choice) return null;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const delta = { ...(asRecord(choice.delta) ?? {}) };
    if (typeof delta.content === "string") this.content += delta.content;
    if (Array.isArray(delta.thinking_blocks)) {
      for (const block of delta.thinking_blocks) {
        const rec = asRecord(block);
        if (rec) this.thinking.push(rec);
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      const forwarded = this.toolDeltas(delta.tool_calls);
      if (forwarded.length) delta.tool_calls = forwarded;
      else delete delta.tool_calls;
    }
    const meaningful = Object.entries(delta).some(([key, value]) => key !== "role" && value !== null && value !== undefined && value !== "");
    if (!meaningful && !delta.role) return null;
    return { ...rest, choices: [{ ...choice, delta, finish_reason: null }] };
  }

  pendingAsCaller(): JsonMap[] {
    const out: JsonMap[] = [];
    for (const slot of this.slots.values()) {
      if (slot.kind !== "pending") continue;
      slot.kind = "caller";
      slot.out = this.nextOut++;
      out.push(...slot.held.map((delta) => ({ ...delta, index: slot.out })));
      slot.held = [];
    }
    return out;
  }

  calls(): McpToolCall[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({ id: slot.id || `call_${newId()}`, name: slot.name, arguments: slot.arguments }));
  }

  assistant(calls: McpToolCall[]): JsonMap {
    return assistantMessage({
      content: this.content,
      thinking_blocks: this.thinking,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
  }
}

function readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  const reader = body?.getReader() ?? null;
  const decoder = new TextDecoder();
  return (async function* () {
    if (!reader) return;
    let leftover = "";
    let drained = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        leftover += decoder.decode(value, { stream: true });
        const parts = leftover.split("\n");
        leftover = parts.pop() ?? "";
        yield* parts;
      }
      drained = true;
      leftover += decoder.decode();
      if (leftover) yield leftover;
    } finally {
      if (!drained) await cancelQuietly(reader);
    }
  })();
}

function chunkOf(line: string): JsonMap | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  return asRecord(parseJsonOrNull(data));
}

function streamingBody(body: JsonMap): JsonMap {
  return {
    ...body,
    stream: true,
    stream_options: { ...(asRecord(body.stream_options) ?? {}), include_usage: true },
  };
}

export function chatStreamSink(wantsUsage: boolean): McpStreamSink {
  return {
    start: () => [],
    chunk(chunk) {
      const out: JsonMap = { ...chunk };
      if (!wantsUsage) delete out.usage;
      const choices = Array.isArray(out.choices) ? out.choices : [];
      if (!choices.length && !asRecord(out.usage)) return [];
      return [sseData(out)];
    },
    toolStart: () => ({ index: 0, events: [] }),
    toolEnd: () => [],
    finish: () => [sseData("[DONE]")],
    fail: (message) => [sseData({ error: { message, type: "server_error", param: null, code: "mcp_tool_loop_failed" } }), sseData("[DONE]")],
    done: async () => {},
  };
}

export async function streamMcpChat(input: {
  req: Request;
  ctx: McpLoopContext;
  body: JsonMap;
  sink: () => Promise<McpStreamSink>;
}): Promise<Response> {
  const { ctx } = input;
  const { toolset, principal } = ctx;
  const deadline = Date.now() + MCP_TOOL_BUDGET_MS;
  const open = (request: JsonMap) =>
    streamChat({
      req: input.req,
      principal,
      model: ctx.model,
      body: request,
      aliases: ctx.aliases,
      outputGuard: ctx.outputGuard,
    });
  let last = isLastStep(0, deadline);
  let request = streamingBody(stepBody(input.body, [], 0, last, toolset));
  let current: Response | null;
  let sink: McpStreamSink;
  try {
    current = await open(request);
  } catch (err) {
    await toolset.executor.close();
    throw err;
  }
  try {
    sink = await input.sink();
  } catch (err) {
    await cancelQuietly(current.body);
    await toolset.executor.close();
    throw err;
  }
  const bytes = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (events: string[]) => {
        if (cancelled) return;
        for (const event of events) controller.enqueue(bytes.encode(event));
      };
      const transcript: JsonMap[] = [];
      let usage: JsonMap | null = null;
      let identity: { id: unknown; created: unknown } | null = null;
      emit(sink.start());
      try {
        for (let step = 0; current && !cancelled; step++) {
          const round = new StreamRound(toolset);
          let failed = false;
          for await (const line of readLines(current.body)) {
            const chunk = chunkOf(line);
            if (!chunk) continue;
            const err = asRecord(chunk.error);
            if (err && !Array.isArray(chunk.choices)) {
              emit(sink.fail(typeof err.message === "string" ? err.message : "upstream error"));
              failed = true;
              break;
            }
            identity ??= { id: chunk.id, created: chunk.created };
            const forwarded = round.take(chunk);
            if (forwarded) emit(sink.chunk({ ...forwarded, id: identity.id, created: identity.created }));
          }
          if (failed) break;
          usage = addChatUsage(usage, round.usage);
          const calls = round.calls();
          const mcp = calls.filter((call) => toolset.byName.has(call.name));
          const callerCalls = calls.filter((call) => !toolset.byName.has(call.name));
          const proceed = mcp.length > 0 && callerCalls.length === 0 && !last && round.finish !== "content_filter";
          const base = { id: identity?.id ?? `chatcmpl_${newId()}`, object: "chat.completion.chunk", created: identity?.created ?? Math.floor(Date.now() / 1000), model: ctx.model };
          if (!proceed) {
            const pending = round.pendingAsCaller();
            if (pending.length) emit(sink.chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: pending }, finish_reason: null }] }));
            transcript.push(round.assistant(callerCalls));
            const finish = round.finish === "tool_calls" && !callerCalls.length ? "stop" : (round.finish ?? "stop");
            emit(sink.chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
            if (usage) emit(sink.chunk({ ...base, choices: [], usage }));
            emit(sink.finish());
            break;
          }
          transcript.push(round.assistant(calls));
          const started = mcp.map((call) => sink.toolStart(call, toolset.byName.get(call.name)!));
          for (const item of started) emit(item.events);
          const records = await executeCalls(ctx, mcp, request, deadline);
          for (const [index, record] of records.entries()) emit(sink.toolEnd(started[index]!.index, record));
          transcript.push(...records.map(toolMessage));
          if (cancelled) break;
          last = isLastStep(step + 1, deadline);
          request = streamingBody(stepBody(input.body, transcript, step + 1, last, toolset));
          await admit(principal, ctx.maxCost);
          await traceStep(principal, request);
          current = await open(request);
        }
      } catch (err) {
        const gate = err instanceof GateError ? err : null;
        if (!gate) logger.error("mcp.loop_failed", errorFields(err));
        emit(sink.fail(gate?.message ?? "the MCP tool loop failed"));
      }
      await toolset.executor.close();
      await sink.done(transcript).catch((err) => {
        logger.error("gateway.stream_finish_failed", errorFields(err));
      });
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      void cancelQuietly(current?.body);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
