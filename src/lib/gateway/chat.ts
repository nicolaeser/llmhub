import "server-only";
import { AnthropicSseTranslator } from "@/lib/gateway/anthropic";
import { recordUsage, usageFromUnknown } from "@/lib/gateway/billing";
import { alertUpstreamFailure } from "@/lib/gateway/alerts";
import { spendTag } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { outputScreen, type OutputScreen } from "@/lib/gateway/guardrails";
import { requestRoutingOverride, serviceModeHeaders } from "@/lib/gateway/service-mode";
import { acquireGroup, loadGroup, markFailure, markSuccess, secretFor } from "@/lib/gateway/runtime";
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
import type { Group, ResolvedDeployment, JsonMap, Usage, Principal } from "@/types/gateway";
import type { OutputGuard } from "@/types/guardrails";
import type { RouteLimits } from "@/types/model-templates";

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
  opts?: { deferRelease?: boolean; strategy?: string },
): Promise<{
  result: T;
  dep: ResolvedDeployment;
  alias: string;
  group: Group;
  release: () => void;
}> {
  let last: unknown = new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
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
    const attempts = Math.max(0, group.num_retries) + 1;
    let stopAlias = false;
    for (let i = 0; i < attempts; i++) {
      try {
        const acquired = await acquireGroup(group, limits[root], undefined, opts?.strategy);
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
          if (retryable(err)) markFailure(acquired.dep);
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

function screenMessage(message: JsonMap | null, apply: (text: string) => string): void {
  if (!message) return;
  if (typeof message.content === "string") message.content = apply(message.content);
  if (typeof message.reasoning_content === "string") message.reasoning_content = apply(message.reasoning_content);
}

export function screenChatJson(json: JsonMap, screen: OutputScreen | null, stream = false): JsonMap {
  if (!screen) return json;
  const apply = (text: string) => (stream ? screen.delta(text) : screen.text(text));
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const rec = choice as JsonMap;
    screenMessage(asRecord(rec.message), apply);
    screenMessage(asRecord(rec.delta), apply);
    if (typeof rec.text === "string") rec.text = apply(rec.text);
  }
  return json;
}

export function withholdChatJson(json: JsonMap): JsonMap {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  json.choices = choices.map((choice) => {
    const rec = asRecord(choice) ?? {};
    const filtered: JsonMap = { ...rec, finish_reason: "content_filter" };
    if (asRecord(rec.message)) filtered.message = { role: "assistant", content: "" };
    if (typeof rec.text === "string") filtered.text = "";
    return filtered;
  });
  return json;
}

function contentFilterChunk(json: JsonMap, model: string): JsonMap {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const indexes = choices.map((choice) => Number(asRecord(choice)?.index ?? 0) || 0);
  return {
    id: json.id,
    object: "chat.completion.chunk",
    created: json.created,
    model,
    choices: (indexes.length ? [...new Set(indexes)] : [0]).map((index) => ({
      index,
      delta: {},
      finish_reason: "content_filter",
    })),
  };
}

export function deploymentKey(dep: ResolvedDeployment): string {
  const apiKey = secretFor(dep);
  if (!apiKey && dep.kind !== "openai_compat") {
    throw new GateError(503, "no_provider_key", "no API key for deployment");
  }
  return apiKey;
}

export async function chatOnce(dep: ResolvedDeployment, group: Group, body: JsonMap, model: string): Promise<unknown> {
  const proxied = await proxyJson({
    dep,
    apiKey: deploymentKey(dep),
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
  const apiKey = deploymentKey(input.dep);
  const signals: AbortSignal[] = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  if (input.req.signal) signals.push(input.req.signal);
  const headers: Record<string, string> = {
    ...mergeUpstreamHeaders(
      upstreamHeaders(input.dep, apiKey, input.headers),
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

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

export async function dispatchChat(input: {
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  outputGuard: OutputGuard | null;
}): Promise<{ json: JsonMap; dep: ResolvedDeployment; alias: string; usage: Partial<Usage> }> {
  const started = Date.now();
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    (dep, group) => chatOnce(dep, group, input.body, input.model),
    { strategy: requestRoutingOverride(input.body) },
  ).catch(async (err) => {
    await recordFailure(input, err, started);
    throw err;
  });
  const { result, dep, alias, group } = routed;

  const screen = outputScreen(input.outputGuard, input.principal.trace);
  const json = screenChatJson({ ...(asRecord(result) ?? {}), model: input.model }, screen);
  if (screen?.blocked) withholdChatJson(json);
  json.model = input.model;
  if (!json.object) json.object = "chat.completion";
  if (!json.id) json.id = `chatcmpl_${newId()}`;
  const usage = usageFromUnknown(json.usage, json);
  await recordUsage({
    principal: input.principal,
    model: input.model,
    deployment: dep,
    group,
    usage,
    status: 200,
    outcome: screen?.blocked ? "guardrail_blocked" : "ok",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    response: json,
  });
  return { json, dep, alias, usage };
}

export async function streamChat(input: {
  req: Request;
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  outputGuard: OutputGuard | null;
}): Promise<Response> {
  const started = Date.now();
  const routed = await withDeployment(
    input.aliases,
    input.principal.routeLimits,
    (dep, group) => openChatStream(dep, group, input),
    { deferRelease: true, strategy: requestRoutingOverride(input.body) },
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
    outputGuard: input.outputGuard,
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
  outputGuard: OutputGuard | null;
  started: number;
}): Response {
  const { dep, group, release, started } = input;
  const screen = outputScreen(input.outputGuard, input.principal.trace);
  const transcript = new ChatStreamTranscript();
  const wantsUsage = asRecord(input.body.stream_options)?.include_usage === true;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = input.res.body!.getReader();
  const translator = dep.kind === "anthropic" ? new AnthropicSseTranslator(input.model) : null;
  let leftover = "";
  let billed = false;
  let ended = false;
  let reported: Partial<Usage> | null = null;
  let streamedText = "";
  let filtered = false;

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
      outcome: screen?.blocked ? "guardrail_blocked" : "ok",
      latencyMs: Date.now() - started,
      tag: spendTag(input.body),
      stream: true,
      request: input.body,
      response: transcript.result(),
    });
  };

  const forward = (json: JsonMap, controller: ReadableStreamDefaultController<Uint8Array>) => {
    screenChatJson(json, screen, true);
    json.model = input.model;
    if (screen?.blocked) {
      if (!filtered) {
        filtered = true;
        const stop = contentFilterChunk(json, input.model);
        transcript.push(stop);
        controller.enqueue(encoder.encode(sseData(JSON.stringify(stop))));
      }
      json.choices = [];
      if (!asRecord(json.usage)) return;
    }
    if (observe(json)) controller.enqueue(encoder.encode(sseData(JSON.stringify(json))));
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
        let json: JsonMap;
        try {
          json = JSON.parse(payload) as JsonMap;
        } catch {
          controller.enqueue(encoder.encode(sseData(payload)));
          continue;
        }
        forward(json, controller);
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
    let json: JsonMap;
    try {
      json = JSON.parse(data) as JsonMap;
    } catch {
      controller.enqueue(encoder.encode(sseData(data)));
      return;
    }
    forward(json, controller);
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
          let json: JsonMap | null = null;
          try {
            json = JSON.parse(flushed) as JsonMap;
          } catch {}
          if (json) forward(json, controller);
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
