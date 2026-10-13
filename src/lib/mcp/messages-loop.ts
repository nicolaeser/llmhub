import "server-only";
import { admit } from "@/lib/gateway/access/gate";
import { dispatchMessages, streamMessages } from "@/lib/gateway/dispatch/messages-dispatch";
import { validRequest } from "@/lib/gateway/endpoints/pipeline";
import { asRecord, newId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { SSE_HEADERS, sseEvent } from "@/lib/gateway/protocols/sse";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import { executeCalls, MCP_MAX_STEPS, MCP_TOOL_BUDGET_MS, toolDescription } from "@/lib/mcp/chat-loop";
import { traceStep } from "@/lib/mcp/screen";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { JsonMap } from "@/types/gateway";
import type { McpCallRecord, McpLoopContext, McpMessagesBlock, McpToolCall, McpToolset } from "@/types/mcp";

const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;

function toolName(value: unknown): string {
  const name = asRecord(value)?.name;
  return typeof name === "string" ? name : "";
}

export function messagesToolNames(body: JsonMap): string[] {
  return (Array.isArray(body.tools) ? body.tools : []).map(toolName).filter(Boolean);
}

export function withMcpMessagesTools(body: JsonMap, toolset: McpToolset): JsonMap {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    ...body,
    tools: [
      ...tools,
      ...toolset.tools.map((bound) => ({
        name: bound.name,
        description: toolDescription(bound),
        input_schema: bound.tool.inputSchema,
      })),
    ],
  };
}

function forces(choice: unknown, toolset: McpToolset): boolean {
  const rec = asRecord(choice);
  return rec?.type === "any" || (rec?.type === "tool" && toolset.byName.has(toolName(rec)));
}

function relaxed(choice: unknown): JsonMap {
  const rec = asRecord(choice) ?? {};
  return typeof rec.disable_parallel_tool_use === "boolean"
    ? { type: "auto", disable_parallel_tool_use: rec.disable_parallel_tool_use }
    : { type: "auto" };
}

export function messagesStepBody(base: JsonMap, transcript: JsonMap[], step: number, last: boolean, toolset: McpToolset): JsonMap {
  const messages = Array.isArray(base.messages) ? base.messages : [];
  const next: JsonMap = { ...base, messages: [...messages, ...transcript] };
  if (step > 0 && forces(next.tool_choice, toolset)) next.tool_choice = relaxed(next.tool_choice);
  if (!last) return next;
  const tools = (Array.isArray(next.tools) ? next.tools : []).filter((tool) => !toolset.byName.has(toolName(tool)));
  if (tools.length) {
    next.tools = tools;
    if (forces(next.tool_choice, toolset)) next.tool_choice = relaxed(next.tool_choice);
  } else {
    delete next.tools;
    delete next.tool_choice;
  }
  return next;
}

function toolUses(content: unknown[]): McpToolCall[] {
  return content.flatMap((raw) => {
    const block = asRecord(raw);
    if (block?.type !== "tool_use" || typeof block.name !== "string") return [];
    return [
      {
        id: typeof block.id === "string" && block.id ? block.id : `toolu_${newId()}`,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    ];
  });
}

export function addMessagesUsage(total: JsonMap, usage: unknown): JsonMap {
  const rec = asRecord(usage) ?? {};
  const out: JsonMap = { ...rec, ...total };
  for (const key of USAGE_KEYS) {
    const left = typeof total[key] === "number" ? (total[key] as number) : 0;
    const right = typeof rec[key] === "number" ? (rec[key] as number) : 0;
    if (key in total || key in rec) out[key] = left + right;
  }
  return out;
}

export function toolResultMessage(records: McpCallRecord[]): JsonMap {
  return {
    role: "user",
    content: records.map((record) => ({
      type: "tool_result",
      tool_use_id: record.call.id,
      content: record.content,
      ...(record.outcome.isError ? { is_error: true } : {}),
    })),
  };
}

function withoutMcpUses(message: JsonMap, toolset: McpToolset, usage: JsonMap): JsonMap {
  const content = Array.isArray(message.content) ? message.content : [];
  const kept = content.filter((raw) => {
    const block = asRecord(raw);
    return !(block?.type === "tool_use" && toolset.byName.has(toolName(block)));
  });
  const anyTool = kept.some((raw) => asRecord(raw)?.type === "tool_use");
  const stop = message.stop_reason === "tool_use" && !anyTool ? "end_turn" : message.stop_reason;
  return { ...message, content: kept, stop_reason: stop, usage };
}

function isLast(step: number, deadline: number): boolean {
  return step >= MCP_MAX_STEPS - 1 || Date.now() >= deadline;
}

export async function runMcpMessages(ctx: McpLoopContext, body: JsonMap, headers: Record<string, string>): Promise<JsonMap> {
  const { toolset, principal } = ctx;
  const deadline = Date.now() + MCP_TOOL_BUDGET_MS;
  const transcript: JsonMap[] = [];
  let usage: JsonMap = {};
  try {
    for (let step = 0; ; step++) {
      const last = isLast(step, deadline);
      const stepRequest = messagesStepBody(body, transcript, step, last, toolset);
      if (step > 0) {
        await admit(principal, ctx.maxCost);
        await traceStep(principal, stepRequest);
      }
      const message = await dispatchMessages({
        principal,
        model: ctx.model,
        body: stepRequest,
        request: validRequest(messagesRequestSchema, stepRequest),
        aliases: ctx.aliases,
        outputGuard: ctx.outputGuard,
        headers,
      });
      usage = addMessagesUsage(usage, message.usage);
      const content = Array.isArray(message.content) ? message.content : [];
      const uses = toolUses(content);
      const mcp = uses.filter((call) => toolset.byName.has(call.name));
      if (!mcp.length || mcp.length < uses.length || last || message.stop_reason !== "tool_use") {
        return withoutMcpUses(message, toolset, usage);
      }
      const records = await executeCalls(ctx, mcp, stepRequest, deadline);
      transcript.push({ role: "assistant", content }, toolResultMessage(records));
    }
  } finally {
    await toolset.executor.close();
  }
}

async function* readEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<JsonMap> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let drained = false;
  const parse = (block: string): JsonMap | null => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data ? asRecord(parseJsonOrNull(data)) : null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parse(block);
        if (event) yield event;
      }
    }
    drained = true;
    buffer += decoder.decode();
    const event = parse(buffer);
    if (event) yield event;
  } finally {
    if (!drained) await cancelQuietly(reader);
  }
}

class MessagesRound {
  stop: unknown = null;
  stopSequence: unknown = null;
  usage: JsonMap = {};
  private blocks = new Map<number, McpMessagesBlock>();

  constructor(
    private readonly toolset: McpToolset,
    private next: () => number,
  ) {}

  take(event: JsonMap): JsonMap | null {
    const index = typeof event.index === "number" ? event.index : -1;
    if (event.type === "message_start") {
      this.usage = { ...(asRecord(asRecord(event.message)?.usage) ?? {}) };
      return event;
    }
    if (event.type === "message_delta") {
      const delta = asRecord(event.delta);
      if (delta && "stop_reason" in delta) this.stop = delta.stop_reason;
      if (delta && "stop_sequence" in delta) this.stopSequence = delta.stop_sequence;
      for (const [key, value] of Object.entries(asRecord(event.usage) ?? {})) {
        if (value !== null && value !== undefined) this.usage[key] = value;
      }
      return null;
    }
    if (event.type === "message_stop") return null;
    if (event.type === "content_block_start") {
      const block = { ...(asRecord(event.content_block) ?? {}) };
      const mcp = block.type === "tool_use" && this.toolset.byName.has(toolName(block));
      const entry: McpMessagesBlock = { block, mcp, out: mcp ? -1 : this.next(), json: "" };
      this.blocks.set(index, entry);
      return mcp ? null : { ...event, index: entry.out };
    }
    const entry = this.blocks.get(index);
    if (event.type === "content_block_delta" && entry) {
      const delta = asRecord(event.delta) ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") entry.block.text = `${String(entry.block.text ?? "")}${delta.text}`;
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        entry.block.thinking = `${String(entry.block.thinking ?? "")}${delta.thinking}`;
      }
      if (delta.type === "signature_delta" && typeof delta.signature === "string") entry.block.signature = delta.signature;
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") entry.json += delta.partial_json;
      return entry.mcp ? null : { ...event, index: entry.out };
    }
    if (event.type === "content_block_stop" && entry) return entry.mcp ? null : { ...event, index: entry.out };
    return event;
  }

  content(): JsonMap[] {
    return [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => {
        if (entry.block.type !== "tool_use") return entry.block;
        const input = entry.json ? asRecord(parseJsonOrNull(entry.json)) : asRecord(entry.block.input);
        return { ...entry.block, input: input ?? {} };
      });
  }
}

function streamFailure(message: string): string {
  return sseEvent("error", { type: "error", error: { type: "api_error", message } });
}

export async function streamMcpMessages(input: {
  req: Request;
  ctx: McpLoopContext;
  body: JsonMap;
  headers: Record<string, string>;
}): Promise<Response> {
  const { ctx } = input;
  const { toolset, principal } = ctx;
  const deadline = Date.now() + MCP_TOOL_BUDGET_MS;
  const open = (body: JsonMap) =>
    streamMessages({
      req: input.req,
      principal,
      model: ctx.model,
      body,
      request: validRequest(messagesRequestSchema, body),
      aliases: ctx.aliases,
      outputGuard: ctx.outputGuard,
      headers: input.headers,
    });
  let last = isLast(0, deadline);
  let request = messagesStepBody(input.body, [], 0, last, toolset);
  let current: Response | null;
  try {
    current = await open(request);
  } catch (err) {
    await toolset.executor.close();
    throw err;
  }
  const bytes = new TextEncoder();
  let cancelled = false;
  let outIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (events: string[]) => {
        if (cancelled) return;
        for (const event of events) controller.enqueue(bytes.encode(event));
      };
      const transcript: JsonMap[] = [];
      let usage: JsonMap = {};
      try {
        for (let step = 0; current && !cancelled; step++) {
          const round = new MessagesRound(toolset, () => outIndex++);
          let failed = false;
          for await (const event of readEvents(current.body)) {
            if (event.type === "error") {
              emit([sseEvent("error", event)]);
              failed = true;
              break;
            }
            const forwarded = round.take(event);
            if (!forwarded || (forwarded.type === "message_start" && step > 0)) continue;
            emit([sseEvent(String(forwarded.type ?? "message"), forwarded)]);
          }
          if (failed) break;
          usage = addMessagesUsage(usage, round.usage);
          const content = round.content();
          const uses = toolUses(content);
          const mcp = uses.filter((call) => toolset.byName.has(call.name));
          const proceed = mcp.length > 0 && mcp.length === uses.length && !last && round.stop === "tool_use";
          if (!proceed) {
            const callerTools = uses.length - mcp.length;
            const stop = round.stop === "tool_use" && !callerTools ? "end_turn" : round.stop;
            emit([
              sseEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stop ?? "end_turn", stop_sequence: round.stopSequence ?? null },
                usage,
              }),
              sseEvent("message_stop", { type: "message_stop" }),
            ]);
            break;
          }
          const records = await executeCalls(ctx, mcp, request, deadline);
          transcript.push({ role: "assistant", content }, toolResultMessage(records));
          if (cancelled) break;
          last = isLast(step + 1, deadline);
          request = messagesStepBody(input.body, transcript, step + 1, last, toolset);
          await admit(principal, ctx.maxCost);
          await traceStep(principal, request);
          current = await open(request);
        }
      } catch (err) {
        const gate = err instanceof GateError ? err : null;
        if (!gate) logger.error("mcp.loop_failed", errorFields(err));
        emit([streamFailure(gate?.message ?? "the MCP tool loop failed")]);
      }
      await toolset.executor.close();
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      void cancelQuietly(current?.body);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
