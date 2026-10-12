import "server-only";
import { dispatchChat, streamChat } from "@/lib/gateway/chat";
import { asNumber, asRecord, newId, stringifyContent } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { allowEndpoint } from "@/lib/gateway/gate";
import { screenRequest } from "@/lib/gateway/guardrails";
import { defaultEntityIds, redactJSON } from "@/lib/gateway/pii";
import { parseRequest, type ResponsesStreamEncoder } from "@/lib/gateway/responses";
import { SSE_HEADERS } from "@/lib/gateway/sse";
import { resolvePolicies } from "@/lib/gateway/settings";
import { searchableStore } from "@/lib/rag/api";
import { rankingOptions } from "@/lib/rag/rank";
import { searchStores } from "@/lib/rag/search";
import { readableStore, usableStore } from "@/lib/rag/stores";
import { fileSearchToolSchema } from "@/schemas/rag";
import type { JsonMap, Principal } from "@/types/gateway";
import type { FileSearchContext, FileSearchRun, FileSearchTool, SearchHit, SearchableStore } from "@/types/rag";

export const FILE_SEARCH = "file_search";
export const FILE_SEARCH_RESULTS = "file_search_call.results";
const MAX_SEARCH_ROUNDS = 3;
const DEFAULT_TOOL_RESULTS = 10;
const MAX_QUERIES = 5;

function isFileSearch(tool: unknown): boolean {
  return asRecord(tool)?.type === FILE_SEARCH;
}

export function takeFileSearchTool(body: JsonMap): { body: JsonMap; tool: FileSearchTool | null } {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const positions = tools.flatMap((tool, i) => (isFileSearch(tool) ? [i] : []));
  if (!positions.length) return { body, tool: null };
  if (positions.length > 1) {
    throw new GateError(400, "invalid_request", "only one file_search tool is supported", { param: "tools" });
  }
  const at = positions[0]!;
  const parsed = parseRequest(fileSearchToolSchema, tools[at]);
  if (!parsed.ok) {
    throw new GateError(400, "invalid_request", parsed.message, {
      param: parsed.param ? `tools.${at}.${parsed.param}` : `tools.${at}`,
    });
  }
  const rest = tools.filter((tool) => !isFileSearch(tool));
  if (rest.some((tool) => asRecord(tool)?.name === FILE_SEARCH)) {
    throw new GateError(400, "invalid_request", "a function tool must not be named file_search", { param: "tools" });
  }
  const next: JsonMap = { ...body, tools: rest };
  const choice = asRecord(body.tool_choice);
  if (choice?.type === FILE_SEARCH) next.tool_choice = "required";
  return {
    body: next,
    tool: {
      vectorStoreIds: [...new Set(parsed.data.vector_store_ids)],
      maxResults: parsed.data.max_num_results ?? DEFAULT_TOOL_RESULTS,
      filters: parsed.data.filters ?? null,
      ranking: rankingOptions(parsed.data.ranking_options),
      original: tools[at] as JsonMap,
    },
  };
}

export async function fileSearchStores(principal: Principal, tool: FileSearchTool): Promise<SearchableStore[]> {
  allowEndpoint(principal, "/v1/vector_stores", "tools");
  const rows = [];
  for (const id of tool.vectorStoreIds) rows.push(usableStore(await readableStore(principal, id)));
  return rows.map(searchableStore);
}

function searchFunction(): JsonMap {
  return {
    type: "function",
    function: {
      name: FILE_SEARCH,
      description:
        "Search the user's uploaded files and knowledge base. Use it whenever the answer may be in those documents. " +
        "Pass one or more short, self-contained search queries.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Search queries; rephrase the question with the key terms.",
          },
        },
        required: ["queries"],
      },
    },
  };
}

function choiceName(choice: unknown): string {
  const rec = asRecord(choice);
  return typeof asRecord(rec?.function)?.name === "string" ? String(asRecord(rec?.function)?.name) : "";
}

export function withFileSearch(chatBody: JsonMap, rawChoice: unknown, parallel: unknown): JsonMap {
  const tools = Array.isArray(chatBody.tools) ? chatBody.tools : [];
  const next: JsonMap = { ...chatBody, tools: [...tools, searchFunction()] };
  const choice = asRecord(rawChoice);
  if (choice?.type === FILE_SEARCH) next.tool_choice = { type: "function", function: { name: FILE_SEARCH } };
  else if (rawChoice === "none" || rawChoice === "required") next.tool_choice = rawChoice;
  if (typeof parallel === "boolean") next.parallel_tool_calls = parallel;
  return next;
}

function forcesSearch(choice: unknown): boolean {
  return choice === "required" || choiceName(choice) === FILE_SEARCH;
}

function roundBody(base: JsonMap, transcript: JsonMap[], round: number): JsonMap {
  const messages = Array.isArray(base.messages) ? base.messages : [];
  const next: JsonMap = { ...base, messages: [...messages, ...transcript] };
  if (round > 0 && forcesSearch(next.tool_choice)) next.tool_choice = "auto";
  if (round < MAX_SEARCH_ROUNDS) return next;
  const tools = (Array.isArray(next.tools) ? next.tools : []).filter((tool) => choiceName(tool) !== FILE_SEARCH);
  if (tools.length) {
    next.tools = tools;
    if (forcesSearch(next.tool_choice)) next.tool_choice = "auto";
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

export function withoutFileSearchHistory(messages: JsonMap[]): JsonMap[] {
  const dropped = new Set<string>();
  const out: JsonMap[] = [];
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string" && dropped.has(message.tool_call_id)) continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const searches = calls.filter(isSearchCall);
    if (message.role !== "assistant" || !searches.length) {
      out.push(message);
      continue;
    }
    for (const call of searches) {
      const id = asRecord(call)?.id;
      if (typeof id === "string") dropped.add(id);
    }
    const rest = calls.filter((call) => choiceName(call) !== FILE_SEARCH);
    const copy: JsonMap = { ...message };
    if (rest.length) copy.tool_calls = rest;
    else delete copy.tool_calls;
    if (rest.length || stringifyContent(copy.content)) out.push(copy);
  }
  return out;
}

export function addChatUsage(a: unknown, b: unknown): JsonMap | null {
  const left = asRecord(a);
  const right = asRecord(b);
  if (!left) return right ? { ...right } : null;
  if (!right) return { ...left };
  const sum = (key: string) => asNumber(left[key]) + asNumber(right[key]);
  const detail = (group: string, key: string) =>
    asNumber(asRecord(left[group])?.[key]) + asNumber(asRecord(right[group])?.[key]);
  return {
    ...left,
    ...right,
    prompt_tokens: sum("prompt_tokens"),
    completion_tokens: sum("completion_tokens"),
    total_tokens: sum("total_tokens"),
    prompt_tokens_details: { cached_tokens: detail("prompt_tokens_details", "cached_tokens") },
    completion_tokens_details: { reasoning_tokens: detail("completion_tokens_details", "reasoning_tokens") },
  };
}

function firstMessage(chat: JsonMap): JsonMap {
  const choice = asRecord(Array.isArray(chat.choices) ? chat.choices[0] : null);
  return asRecord(choice?.message) ?? {};
}

function callsOf(message: JsonMap): JsonMap[] {
  return (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((call) => {
    const rec = asRecord(call);
    return rec ? [rec] : [];
  });
}

export function assistantMessage(message: JsonMap): JsonMap {
  const out: JsonMap = { role: "assistant", content: stringifyContent(message.content) || null };
  if (Array.isArray(message.thinking_blocks) && message.thinking_blocks.length) out.thinking_blocks = message.thinking_blocks;
  const calls = callsOf(message).map((call) => {
    const fn = asRecord(call.function) ?? {};
    return {
      id: typeof call.id === "string" && call.id ? call.id : `call_${newId()}`,
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    };
  });
  if (calls.length) out.tool_calls = calls;
  return out;
}

export function searchQueries(args: unknown): string[] {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args || "{}");
    } catch {
      parsed = { query: args };
    }
  }
  const rec = asRecord(parsed) ?? {};
  const list = Array.isArray(rec.queries) ? rec.queries : typeof rec.query === "string" ? [rec.query] : [];
  return list
    .filter((query): query is string => typeof query === "string")
    .map((query) => query.trim().slice(0, 4096))
    .filter(Boolean)
    .slice(0, MAX_QUERIES);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function searchResultText(hits: SearchHit[]): string {
  if (!hits.length) return "No matching content was found in the attached files.";
  return hits
    .map(
      (hit, i) =>
        `<result index="${i + 1}" file_id="${escapeAttribute(hit.fileId)}" filename="${escapeAttribute(hit.filename)}" score="${hit.score.toFixed(3)}">\n${hit.text}\n</result>`,
    )
    .join("\n\n");
}

async function screenRetrieved(principal: Principal, text: string): Promise<string> {
  const { pii, guardrails } = await resolvePolicies(principal);
  const screened = screenRequest({ content: text }, guardrails, principal.trace?.guardInput ?? new Set());
  if (screened.blocked) {
    if (principal.trace) principal.trace.guardBlocked = true;
    throw new GateError(400, "guardrail_blocked", "file search results were blocked by the guardrail policy");
  }
  const content = typeof screened.body.content === "string" ? screened.body.content : text;
  if (!pii.enabled) return content;
  const found = new Set<string>();
  const redacted = redactJSON(content, pii.entities.length ? pii.entities : defaultEntityIds(), "", found) as string;
  for (const id of found) principal.trace?.piiInput.add(id);
  if (pii.mode === "block" && found.size) {
    throw new GateError(400, "pii_blocked", "file search results were blocked by the PII policy");
  }
  return redacted;
}

async function runSearch(ctx: FileSearchContext, call: JsonMap): Promise<{ item: JsonMap; message: JsonMap }> {
  const fn = asRecord(call.function) ?? {};
  const queries = searchQueries(fn.arguments);
  const hits = queries.length
    ? await searchStores({
        principal: ctx.principal,
        endpoint: ctx.principal.trace?.endpoint ?? "/v1/responses",
        stores: ctx.stores,
        request: {
          queries,
          filters: ctx.tool.filters,
          maxResults: ctx.tool.maxResults,
          ranking: ctx.tool.ranking,
          rerankModel: null,
        },
      })
    : [];
  const withResults = ctx.include?.includes(FILE_SEARCH_RESULTS) ?? false;
  return {
    item: {
      id: `fs_${newId()}`,
      type: "file_search_call",
      status: "completed",
      queries,
      results: withResults
        ? hits.map((hit) => ({
            file_id: hit.fileId,
            filename: hit.filename,
            score: hit.score,
            text: hit.text,
            attributes: hit.attributes,
          }))
        : null,
    },
    message: {
      role: "tool",
      tool_call_id: typeof call.id === "string" ? call.id : "",
      content: await screenRetrieved(ctx.principal, searchResultText(hits)),
    },
  };
}

function isSearchCall(call: unknown): boolean {
  return choiceName(call) === FILE_SEARCH;
}

function withoutSearchCalls(chat: JsonMap, usage: JsonMap | null): JsonMap {
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  return {
    ...chat,
    usage,
    choices: choices.map((raw, i) => {
      const choice = asRecord(raw);
      if (!choice || i > 0) return raw;
      const message = asRecord(choice.message) ?? {};
      return {
        ...choice,
        message: { ...message, tool_calls: callsOf(message).filter((call) => choiceName(call) !== FILE_SEARCH) },
      };
    }),
  };
}

export async function runFileSearch(ctx: FileSearchContext, body: JsonMap): Promise<FileSearchRun> {
  const transcript: JsonMap[] = [];
  const items: JsonMap[] = [];
  let usage: JsonMap | null = null;
  for (let round = 0; ; round++) {
    const { json } = await dispatchChat({
      principal: ctx.principal,
      model: ctx.model,
      body: roundBody(body, transcript, round),
      aliases: ctx.aliases,
      outputGuard: ctx.outputGuard,
    });
    usage = addChatUsage(usage, json.usage);
    const message = firstMessage(json);
    const calls = callsOf(message);
    const searches = calls.filter(isSearchCall);
    if (!searches.length || round >= MAX_SEARCH_ROUNDS) {
      const final = searches.length ? withoutSearchCalls(json, usage) : { ...json, usage };
      transcript.push(assistantMessage(firstMessage(final)));
      return { final, items, transcript };
    }
    transcript.push(assistantMessage(message));
    for (const call of searches) {
      const result = await runSearch(ctx, call);
      items.push(result.item);
      transcript.push(result.message);
    }
    if (calls.length > searches.length) return { final: withoutSearchCalls(json, usage), items, transcript };
  }
}

type RoundMessage = {
  content: string;
  thinking: JsonMap[];
  calls: Map<number, { id: string; name: string; arguments: string }>;
};

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
      if (!drained) await reader.cancel().catch(() => undefined);
    }
  })();
}

function chunkOf(line: string): JsonMap | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

function collect(round: RoundMessage, delta: JsonMap): JsonMap {
  if (typeof delta.content === "string") round.content += delta.content;
  if (Array.isArray(delta.thinking_blocks)) {
    for (const block of delta.thinking_blocks) {
      const rec = asRecord(block);
      if (rec) round.thinking.push(rec);
    }
  }
  if (!Array.isArray(delta.tool_calls)) return delta;
  const kept = delta.tool_calls.filter((raw, position) => {
    const call = asRecord(raw);
    if (!call) return false;
    const index = typeof call.index === "number" ? call.index : position;
    const fn = asRecord(call.function);
    const slot = round.calls.get(index) ?? { id: "", name: "", arguments: "" };
    if (!slot.id && typeof call.id === "string") slot.id = call.id;
    if (!slot.name && typeof fn?.name === "string") slot.name = fn.name;
    if (typeof fn?.arguments === "string") slot.arguments += fn.arguments;
    round.calls.set(index, slot);
    return slot.name !== FILE_SEARCH;
  });
  return { ...delta, tool_calls: kept };
}

function roundAssistant(round: RoundMessage): JsonMap {
  return assistantMessage({
    content: round.content,
    thinking_blocks: round.thinking,
    tool_calls: [...round.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
  });
}

export async function streamFileSearch(input: {
  req: Request;
  ctx: FileSearchContext;
  body: JsonMap;
  prepare: () => Promise<{ encoder: ResponsesStreamEncoder; onDone: (transcript: JsonMap[]) => Promise<void> }>;
}): Promise<Response> {
  const { ctx } = input;
  const open = (round: number, transcript: JsonMap[]) =>
    streamChat({
      req: input.req,
      principal: ctx.principal,
      model: ctx.model,
      body: roundBody(input.body, transcript, round),
      aliases: ctx.aliases,
      outputGuard: ctx.outputGuard,
    });
  const first = await open(0, []);
  let prepared: Awaited<ReturnType<typeof input.prepare>>;
  try {
    prepared = await input.prepare();
  } catch (err) {
    await first.body?.cancel().catch(() => undefined);
    throw err;
  }
  const { encoder, onDone } = prepared;
  const bytes = new TextEncoder();
  let cancelled = false;
  let current: Response | null = first;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (events: string[]) => {
        if (cancelled) return;
        for (const event of events) controller.enqueue(bytes.encode(event));
      };
      const transcript: JsonMap[] = [];
      let usage: JsonMap | null = null;
      emit(encoder.start());
      try {
        for (let round = 0; current && !cancelled; round++) {
          const message: RoundMessage = { content: "", thinking: [], calls: new Map() };
          let roundUsage: JsonMap | null = null;
          let failed = false;
          for await (const line of readLines(current.body)) {
            const chunk = chunkOf(line);
            if (!chunk) continue;
            const err = asRecord(chunk.error);
            if (err && !Array.isArray(chunk.choices)) {
              emit(encoder.fail(typeof err.message === "string" ? err.message : "upstream error"));
              failed = true;
              break;
            }
            if (asRecord(chunk.usage)) roundUsage = asRecord(chunk.usage);
            const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
            const forwarded: JsonMap = {
              ...chunk,
              ...(roundUsage ? { usage: addChatUsage(usage, roundUsage) } : {}),
              choices: choices.map((raw) => {
                const choice = asRecord(raw);
                if (!choice || Number(choice.index ?? 0) !== 0) return raw;
                const delta = asRecord(choice.delta);
                return delta ? { ...choice, delta: collect(message, delta) } : choice;
              }),
            };
            emit(encoder.push(forwarded));
          }
          if (failed) break;
          usage = addChatUsage(usage, roundUsage);
          const assistant = roundAssistant(message);
          const calls = callsOf(assistant);
          const searches = calls.filter(isSearchCall);
          if (!searches.length || round >= MAX_SEARCH_ROUNDS) {
            const rest = calls.filter((call) => !isSearchCall(call));
            transcript.push(assistantMessage({ ...assistant, tool_calls: rest }));
            emit(encoder.finish());
            break;
          }
          transcript.push(assistant);
          for (const call of searches) {
            const pending = { id: `fs_${newId()}`, type: "file_search_call", status: "in_progress", queries: [], results: null };
            const begun = encoder.beginItem(pending, [
              "response.file_search_call.in_progress",
              "response.file_search_call.searching",
            ]);
            emit(begun.events);
            const result = await runSearch(ctx, call);
            const item = { ...result.item, id: pending.id };
            emit(encoder.endItem(begun.index, item, ["response.file_search_call.completed"]));
            transcript.push(result.message);
          }
          if (calls.length > searches.length) {
            emit(encoder.finish());
            break;
          }
          current = cancelled ? null : await open(round + 1, transcript);
        }
      } catch (err) {
        const gate = err instanceof GateError ? err : null;
        emit(encoder.fail(gate?.message ?? "file search failed"));
      }
      await onDone(transcript).catch(() => undefined);
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      void current?.body?.cancel().catch(() => undefined);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
