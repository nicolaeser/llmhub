import "server-only";
import { AnthropicSseTranslator } from "@/lib/gateway/anthropic";
import { recordUsage, usageFromUnknown } from "@/lib/gateway/billing";
import { alertUpstreamFailure } from "@/lib/gateway/alerts";
import { spendTag } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { redactPii } from "@/lib/gateway/pii";
import { requestRoutingOverride, serviceModeHeaders } from "@/lib/gateway/service-mode";
import { acquireGroup, loadGroup, markFailure, markSuccess } from "@/lib/gateway/runtime";
import { CodexSseTranslator } from "@/lib/gateway/codex";
import { deploymentAuth } from "@/lib/gateway/credentials";
import { inPool, outsidePool } from "@/lib/gateway/route-pool";
import { SSE_HEADERS } from "@/lib/gateway/sse";
import {
  joinPath,
  mergeUpstreamHeaders,
  prepareBody,
  proxyJson,
  retryableStatus,
  upstreamError,
  upstreamHeaders,
} from "@/lib/gateway/upstream";
import { asRecord, isRouterError, newId, stringifyContent } from "@/lib/gateway/core";
import { ChatStreamTranscript } from "@/lib/gateway/log-content";
import { estimateTokens, requestText } from "@/lib/gateway/tokens";
import type {
  ChatSseTranslator,
  Group,
  ResolvedDeployment,
  JsonMap,
  Usage,
  Principal,
  RoutePool,
} from "@/types/gateway";
import type { RouteLimits } from "@/types/model-templates";
import type { ResponseCacheUsage } from "@/types/cache";

export const UPSTREAM_TIMEOUT_MS = 300_000;

function failureStatus(err: unknown): number {
  if (err instanceof GateError) return err.status;
  if (isRouterError(err)) return err.code === "unknown_group" ? 404 : 503;
  return 502;
}

export async function recordFailure(
  input: { principal: Principal; model: string; body: JsonMap },
  err: unknown,
  started: number,
) {
  await recordUsage({
    principal: input.principal,
    model: input.model,
    status: failureStatus(err),
    outcome: "error",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    error: err,
  }).catch(() => undefined);
}

function retryable(err: unknown): boolean {
  if (err instanceof GateError) return retryableStatus(err.status);
  if (isRouterError(err)) return true;
  return true;
}

function fallbackable(err: unknown): boolean {
  if (isRouterError(err)) return true;
  if (err instanceof GateError) return retryableStatus(err.status);
  return true;
}

export async function withDeployment<T>(
  aliases: string[],
  limits: RouteLimits,
  fn: (dep: ResolvedDeployment, group: Group) => Promise<T>,
  opts?: { deferRelease?: boolean; strategy?: string; pool?: RoutePool },
): Promise<{
  result: T;
  dep: ResolvedDeployment;
  alias: string;
  group: Group;
  release: () => void;
}> {
  let last: unknown = new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  const pool = opts?.pool ?? "api";
  const routable = inPool(pool);
  const queue = aliases.map((alias) => ({ alias, root: alias }));
  for (let qi = 0; qi < queue.length; qi++) {
    const { alias, root } = queue[qi]!;
    let group: Group;
    try {
      group = await loadGroup(alias);
    } catch (err) {
      last = err;
      continue;
    }
    const reachable = !group.mapped.length || group.mapped.some(routable) || Boolean(group.overflow_group);
    if (!reachable) last = outsidePool(pool);
    const attempts = reachable ? Math.max(0, group.num_retries) + 1 : 0;
    let stopAlias = false;
    for (let i = 0; i < attempts; i++) {
      try {
        const acquired = await acquireGroup(group, limits[root], routable, opts?.strategy);
        try {
          const started = Date.now();
          const result = await fn(acquired.dep, group);
          markSuccess(acquired.dep, Date.now() - started);
          if (!opts?.deferRelease) {
            acquired.release();
            return { result, dep: acquired.dep, alias, group, release: () => {} };
          }
          return {
            result,
            dep: acquired.dep,
            alias,
            group,
            release: acquired.release,
          };
        } catch (err) {
          acquired.release();
          if (retryable(err)) markFailure(acquired.dep, err instanceof GateError ? err.retryAt : null);
          last = err;
          if (!retryable(err)) {
            stopAlias = true;
            if (!fallbackable(err)) throw err;
            break;
          }
        }
      } catch (err) {
        last = err;
        if (!fallbackable(err)) throw err;
        break;
      }
    }
    for (const fb of group.fallback_groups) {
      if (!queue.some((entry) => entry.alias === fb)) queue.push({ alias: fb, root });
    }
    if (!stopAlias && group.overflow_group && !queue.some((entry) => entry.alias === group.overflow_group)) {
      queue.push({ alias: group.overflow_group, root });
    }
  }
  await alertUpstreamFailure(last);
  throw last;
}

function redactMessage(message: JsonMap | null, entities: string[], found?: Set<string>): void {
  if (!message) return;
  if (typeof message.content === "string") message.content = redactPii(message.content, entities, found);
  if (typeof message.reasoning_content === "string") {
    message.reasoning_content = redactPii(message.reasoning_content, entities, found);
  }
}

export function redactChatJson(json: JsonMap, entities: string[] | null, found?: Set<string>): JsonMap {
  if (!entities) return json;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const rec = choice as JsonMap;
    redactMessage(asRecord(rec.message), entities, found);
    redactMessage(asRecord(rec.delta), entities, found);
    if (typeof rec.text === "string") rec.text = redactPii(rec.text, entities, found);
  }
  return json;
}

export async function chatOnce(dep: ResolvedDeployment, group: Group, body: JsonMap, model: string): Promise<unknown> {
  const proxied = await proxyJson({
    dep,
    auth: await deploymentAuth(dep),
    path: "/chat/completions",
    body: { ...body, model: dep.model || model, stream: false },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    groupStrategy: group.strategy,
  });
  if (!proxied.status || proxied.status >= 400) throw upstreamError(proxied.status, proxied.json);
  return proxied.json;
}

export async function openUpstreamStream(input: {
  dep: ResolvedDeployment;
  group: Group;
  req: Request;
  path: string;
  payload: JsonMap;
  form?: FormData;
  headers?: Record<string, string>;
}): Promise<Response> {
  const auth = await deploymentAuth(input.dep);
  const signals: AbortSignal[] = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  if (input.req.signal) signals.push(input.req.signal);
  const headers: Record<string, string> = {
    ...mergeUpstreamHeaders(
      upstreamHeaders(input.dep, auth, input.headers),
      serviceModeHeaders(input.dep.kind, input.payload, input.group.strategy, input.dep.model),
    ),
    Accept: "text/event-stream",
  };
  if (input.form) delete headers["Content-Type"];
  const res = await fetch(joinPath(input.dep, input.path), {
    method: "POST",
    headers,
    body: input.form ?? JSON.stringify(input.payload),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (json) throw upstreamError(res.status, json);
    throw new GateError(res.status || 502, "upstream_error", text.slice(0, 512) || "upstream error");
  }
  return res;
}

export function openChatStream(
  dep: ResolvedDeployment,
  group: Group,
  input: { req: Request; model: string; body: JsonMap },
): Promise<Response> {
  const payload = prepareBody(
    dep,
    "/chat/completions",
    {
      ...input.body,
      model: dep.model || input.model,
      stream: true,
      stream_options: { ...(asRecord(input.body.stream_options) ?? {}), include_usage: true },
    },
    group.strategy,
  );
  return openUpstreamStream({ dep, group, req: input.req, path: "/chat/completions", payload });
}

function streamTranslator(dep: ResolvedDeployment, model: string): ChatSseTranslator | null {
  if (dep.kind === "anthropic") return new AnthropicSseTranslator(model);
  if (dep.kind === "codex") return new CodexSseTranslator(model);
  return null;
}

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

export async function dispatchChat(input: {
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  outputPii: string[] | null;
  responseCache?: ResponseCacheUsage;
}): Promise<{ json: JsonMap; dep: ResolvedDeployment; alias: string; usage: Partial<Usage>; cost: number }> {
  const started = Date.now();
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    (dep, group) => chatOnce(dep, group, input.body, input.model),
    { strategy: requestRoutingOverride(input.body), pool: input.principal.pool },
  ).catch(async (err) => {
    await recordFailure(input, err, started);
    throw err;
  });
  const { result, dep, alias, group } = routed;

  const json = redactChatJson(
    { ...(asRecord(result) ?? {}), model: input.model },
    input.outputPii,
    input.principal.trace?.piiOutput,
  );
  json.model = input.model;
  if (!json.object) json.object = "chat.completion";
  if (!json.id) json.id = `chatcmpl_${newId()}`;
  const usage = usageFromUnknown(json.usage, json);
  const cost = await recordUsage({
    principal: input.principal,
    model: input.model,
    deployment: dep,
    group,
    usage,
    status: 200,
    outcome: "ok",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    response: json,
    responseCache: input.responseCache,
  });
  return { json, dep, alias, usage, cost };
}

export async function streamChat(input: {
  req: Request;
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  outputPii: string[] | null;
}): Promise<Response> {
  const started = Date.now();
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    (dep, group) => openChatStream(dep, group, input),
    { deferRelease: true, strategy: requestRoutingOverride(input.body), pool: input.principal.pool },
  ).catch(async (err) => {
    await recordFailure(input, err, started);
    throw err;
  });
  return relayChatStream({
    res: routed.result,
    dep: routed.dep,
    group: routed.group,
    release: routed.release,
    principal: input.principal,
    model: input.model,
    body: input.body,
    entities: input.outputPii,
    started,
  });
}

export function relayChatStream(input: {
  res: Response;
  dep: ResolvedDeployment;
  group: Group;
  release: () => void;
  principal: Principal;
  model: string;
  body: JsonMap;
  entities: string[] | null;
  started: number;
}): Response {
  const { dep, group, release, entities, started } = input;
  const found = input.principal.trace?.piiOutput;
  const transcript = new ChatStreamTranscript();
  const wantsUsage = asRecord(input.body.stream_options)?.include_usage === true;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = input.res.body!.getReader();
  const translator = streamTranslator(dep, input.model);
  let leftover = "";
  let billed = false;
  let ended = false;
  let reported: Partial<Usage> | null = null;
  let streamedText = "";

  const observe = (json: JsonMap): boolean => {
    transcript.push(json);
    const usage = asRecord(json.usage);
    if (usage) reported = usageFromUnknown(usage, json);
    const choices = Array.isArray(json.choices) ? json.choices : [];
    for (const choice of choices) {
      const delta = asRecord(asRecord(choice)?.delta);
      if (delta) streamedText += stringifyContent(delta.content) + stringifyContent(delta.reasoning_content);
    }
    if (!wantsUsage) {
      delete json.usage;
      if (usage && choices.length === 0) return false;
    }
    return true;
  };

  const finish = async () => {
    release();
    if (billed) return;
    billed = true;
    const prompt = estimateTokens(requestText(input.body));
    const completion = estimateTokens(streamedText);
    await recordUsage({
      principal: input.principal,
      model: input.model,
      deployment: dep,
      group,
      usage: reported ?? {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      },
      status: 200,
      outcome: "ok",
      latencyMs: Date.now() - started,
      tag: spendTag(input.body),
      stream: true,
      request: input.body,
      response: transcript.result(),
    });
  };

  const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ended) return;
    ended = true;
    controller.enqueue(encoder.encode(sseData("[DONE]")));
  };

  const emitLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (translator) {
      for (const payload of translator.pushLine(line)) {
        if (payload === "[DONE]") {
          end(controller);
          continue;
        }
        try {
          const json = redactChatJson(JSON.parse(payload) as JsonMap, entities, found);
          json.model = input.model;
          if (observe(json)) controller.enqueue(encoder.encode(sseData(JSON.stringify(json))));
        } catch {
          controller.enqueue(encoder.encode(sseData(payload)));
        }
      }
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      end(controller);
      return;
    }
    try {
      const json = JSON.parse(data) as JsonMap;
      json.model = input.model;
      redactChatJson(json, entities, found);
      if (observe(json)) controller.enqueue(encoder.encode(sseData(JSON.stringify(json))));
    } catch {
      controller.enqueue(encoder.encode(sseData(data)));
    }
  };

  const step = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const { done, value } = await reader.read();
    if (done) {
      leftover += decoder.decode();
      if (leftover) {
        for (const line of leftover.split("\n")) emitLine(line, controller);
      }
      if (translator) {
        const flushed = translator.flush();
        if (flushed && flushed !== "[DONE]") {
          try {
            const json = redactChatJson(JSON.parse(flushed) as JsonMap, entities, found);
            json.model = input.model;
            if (observe(json)) controller.enqueue(encoder.encode(sseData(JSON.stringify(json))));
          } catch {}
        }
      }
      end(controller);
      controller.close();
      await finish();
      return;
    }
    leftover += decoder.decode(value, { stream: true });
    const parts = leftover.split("\n");
    leftover = parts.pop() ?? "";
    for (const line of parts) emitLine(line, controller);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await step(controller);
      } catch (err) {
        await finish();
        controller.error(err);
      }
    },
    cancel() {
      void reader.cancel();
      void finish();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
