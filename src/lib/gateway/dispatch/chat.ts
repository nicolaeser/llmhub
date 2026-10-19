import "server-only";
import { AnthropicSseTranslator } from "@/lib/gateway/protocols/anthropic";
import { recordUsage, recordUsageOrLog, usageFromUnknown } from "@/lib/gateway/billing/billing";
import { alertUpstreamFailure } from "@/lib/alerts/notify";
import { spendTag } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { outputScreen, type OutputScreen } from "@/lib/gateway/safety/guardrails";
import { requestRoutingOverride, serviceModeHeaders, variantRoutes } from "@/lib/gateway/dispatch/service-mode";
import { accessOf } from "@/lib/gateway/routing/account-access";
import { runSession, writePin } from "@/lib/gateway/routing/account-affinity";
import {
  dropAccountReasoning,
  historyLength,
  nextPin,
  rejectsForeignReasoning,
} from "@/lib/gateway/routing/account-handoff";
import { acquireGroup, loadGroup, markFailure, markSuccess } from "@/lib/gateway/routing/runtime";
import { isSignInKind, speaksAnthropic } from "@/lib/gateway/upstreams/provider-kinds";
import { AntigravitySseTranslator, withProject } from "@/lib/gateway/upstreams/antigravity";
import { CodexSseTranslator } from "@/lib/gateway/upstreams/codex";
import { deploymentAuth, renewRejectedLogin } from "@/lib/gateway/upstreams/credentials";
import { autoRedeemIfDue } from "@/lib/gateway/upstreams/reset-redeem";
import { plainModel } from "@/lib/gateway/catalog/model-alias";
import { inPool, outsidePool, routeOf } from "@/lib/gateway/routing/route-pool";
import { KEEPALIVE_MS, SSE_HEADERS, SSE_KEEPALIVE, sseData } from "@/lib/gateway/protocols/sse";
import {
  joinPath,
  mergeUpstreamHeaders,
  prepareBody,
  proxyJson,
  retryableStatus,
  upstreamError,
  upstreamHeaders,
} from "@/lib/gateway/dispatch/upstream";
import { asRecord, isRouterError, isUnavailableError, newId, routerGateError, stringifyContent } from "@/lib/gateway/core";
import { costFilter, costRejected } from "@/lib/gateway/billing/cost-cap";
import { ChatStreamTranscript } from "@/lib/gateway/request-logs/log-content";
import { estimateTokens, requestText } from "@/lib/gateway/billing/tokens";
import { parseJsonOrNull, readTextOr } from "@/lib/utils/json";
import { cancelQuietly, DeadlineReader } from "@/lib/utils/streams";
import type { ChatSseTranslator, JsonMap, Principal, RequestTrace } from "@/types/gateway";
import type { CostFilter, TokenUsage } from "@/types/billing";
import type { AccountPin, ResolvedModelGroup, ResolvedDeployment, RoutePool, RunRouting } from "@/types/routing";
import type { SignInKind } from "@/types/providers";
import type { OutputGuard } from "@/types/guardrails";
import type { RouteLimits } from "@/types/model-templates";
import type { ResponseCacheUsage } from "@/types/cache";

export const UPSTREAM_TIMEOUT_MS = 300_000;

function failureStatus(err: unknown): number {
  if (err instanceof GateError) return err.status;
  const routed = routerGateError(err);
  if (routed) return routed.status;
  return isRouterError(err) ? 503 : 502;
}

export async function recordFailure(
  input: { principal: Principal; model: string; body: JsonMap },
  err: unknown,
  started: number,
) {
  await recordUsageOrLog({
    principal: input.principal,
    model: input.model,
    status: failureStatus(err),
    outcome: "error",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    error: err,
  });
}

type MeteredCall = { principal: Principal; model: string; body: JsonMap; aliases: string[] };

export async function routeMetered<T>(
  input: MeteredCall,
  started: number,
  fn: (dep: ResolvedDeployment, group: ResolvedModelGroup) => Promise<T>,
  opts: { deferRelease?: boolean } = {},
) {
  const routing = {
    ...opts,
    strategy: requestRoutingOverride(input.body),
    principal: input.principal,
    cost: costFilter(input.principal, input.body),
    request: input.body,
  };
  try {
    return await withDeployment(input.aliases, input.principal.routeLimits, fn, routing);
  } catch (err) {
    await recordFailure(input, err, started);
    throw err;
  }
}

export function recordSuccess(
  input: { principal: Principal; model: string; body: JsonMap },
  routed: { dep: ResolvedDeployment; group: ResolvedModelGroup },
  outcome: {
    usage: Partial<TokenUsage>;
    blocked: boolean;
    started: number;
    response: unknown;
    stream?: true;
    responseCache?: ResponseCacheUsage;
  },
): Promise<number> {
  return recordUsage({
    principal: input.principal,
    model: input.model,
    deployment: routed.dep,
    group: routed.group,
    usage: outcome.usage,
    status: 200,
    outcome: outcome.blocked ? "guardrail_blocked" : "ok",
    latencyMs: Date.now() - outcome.started,
    tag: spendTag(input.body),
    stream: outcome.stream,
    request: input.body,
    response: outcome.response,
    responseCache: outcome.responseCache,
  });
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

function signInAccount(dep: ResolvedDeployment): string | null {
  return dep.provider && isSignInKind(dep.provider.kind) ? dep.provider.id : null;
}

function failureCode(err: unknown): { status: number; code: string } {
  const rec = err instanceof Error ? (err as Error & { status?: unknown; code?: unknown }) : null;
  return {
    status: typeof rec?.status === "number" ? rec.status : 0,
    code: typeof rec?.code === "string" ? rec.code : "",
  };
}

function unauthorized(err: unknown): boolean {
  return failureCode(err).status === 401;
}

function accountUnusable(err: unknown): boolean {
  const { status, code } = failureCode(err);
  return status === 429 || status === 401 || code === "no_provider_key";
}

function accountBudget(deployments: ResolvedDeployment[]): number {
  return new Set(deployments.flatMap((dep) => signInAccount(dep) ?? [])).size;
}

function prepareHandoff(dep: ResolvedDeployment, pinned: AccountPin | null, switched: boolean, request: JsonMap | null): void {
  if (!request || dep.kind !== "codex") return;
  const account = signInAccount(dep);
  if (switched || (pinned && pinned.providerId !== account)) dropAccountReasoning(request);
  else if (pinned && pinned.handoffAt > 0) dropAccountReasoning(request, pinned.handoffAt);
}

export async function withDeployment<T>(
  aliases: string[],
  limits: RouteLimits,
  fn: (dep: ResolvedDeployment, group: ResolvedModelGroup) => Promise<T>,
  opts?: {
    deferRelease?: boolean;
    strategy?: string;
    pool?: RoutePool;
    cost?: CostFilter;
    principal?: Principal;
    request?: JsonMap;
  },
): Promise<{
  result: T;
  dep: ResolvedDeployment;
  alias: string;
  group: ResolvedModelGroup;
  release: () => void;
}> {
  let last: unknown = new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  let upstreamFailure: unknown = null;
  const surface = opts?.pool ?? opts?.principal?.pool ?? "api";
  const access = accessOf(opts?.principal);
  const request = opts?.request ?? null;
  const run: RunRouting = { session: runSession(request), tried: new Set() };
  const renewed = new Set<string>();
  let reasoningDropped = false;
  let failedAccount: string | null = null;
  const queue = aliases.map((entry) => {
    const route = routeOf(entry, surface);
    return { alias: route.alias, root: route.alias, pool: route.pool };
  });
  for (let qi = 0; qi < queue.length; qi++) {
    const { alias, root, pool } = queue[qi]!;
    let group: ResolvedModelGroup;
    try {
      group = await loadGroup(alias);
    } catch (err) {
      last = err;
      continue;
    }
    const pooled = group.mapped.filter(inPool(pool));
    const variants = variantRoutes(pooled, opts?.request);
    const routable = (dep: ResolvedDeployment) => inPool(pool)(dep) && variants.serves(dep);
    const reachable = !group.mapped.length || group.mapped.some(routable) || Boolean(group.overflow_group);
    if (!reachable) last = pooled.length && variants.error ? variants.error : outsidePool(pool, surface);
    const attempts = reachable ? Math.max(0, group.num_retries) + 1 : 0;
    const switchBudget = accountBudget(pooled.filter(routable));
    let switches = 0;
    let stopAlias = false;
    for (let i = 0; i < attempts; i++) {
      try {
        const acquired = await acquireGroup(group, limits[root], routable, opts?.strategy, opts?.cost, access, run);
        const account = signInAccount(acquired.dep);
        const switched = account !== null && failedAccount !== null && failedAccount !== account;
        prepareHandoff(acquired.dep, acquired.pinned, switched, request);
        try {
          const started = Date.now();
          const result = await fn(acquired.dep, group);
          markSuccess(acquired.dep, Date.now() - started);
          if (account && run.session) {
            void writePin(
              acquired.dep.provider!.kind,
              run.session,
              nextPin(account, acquired.pinned, switched, historyLength(request)),
            );
          }
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
          if (account && unauthorized(err) && !renewed.has(account)) {
            renewed.add(account);
            if (await renewRejectedLogin(account, acquired.dep.provider!.kind as SignInKind)) {
              i--;
              continue;
            }
          }
          if (!reasoningDropped && acquired.dep.kind === "codex" && rejectsForeignReasoning(err) && dropAccountReasoning(request)) {
            reasoningDropped = true;
            i--;
            continue;
          }
          if (retryable(err)) markFailure(acquired.dep, err instanceof GateError ? err.retryAt : null);
          last = err;
          if (!isRouterError(err)) upstreamFailure = err;
          if (account && failureCode(err).status === 429) void autoRedeemIfDue(account);
          if (account && accountUnusable(err)) {
            run.tried.add(acquired.dep.id);
            failedAccount = account;
            if (switches < switchBudget) {
              switches++;
              i--;
            }
            continue;
          }
          if (!retryable(err)) {
            stopAlias = true;
            if (!fallbackable(err)) throw err;
            break;
          }
        }
      } catch (err) {
        last = err;
        if (!fallbackable(err) || costRejected(err)) throw err;
        break;
      }
    }
    for (const fb of group.fallback_groups) {
      if (!queue.some((entry) => entry.alias === fb && entry.pool === pool)) queue.push({ alias: fb, root, pool });
    }
    if (
      !stopAlias &&
      group.overflow_group &&
      !queue.some((entry) => entry.alias === group.overflow_group && entry.pool === pool)
    ) {
      queue.push({ alias: group.overflow_group, root, pool });
    }
  }
  const failure = upstreamFailure && isUnavailableError(last) ? upstreamFailure : last;
  await alertUpstreamFailure(failure);
  throw failure;
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

export function screenChatOutput(json: JsonMap, guard: OutputGuard | null, trace?: RequestTrace): boolean {
  const screen = outputScreen(guard, trace);
  screenChatJson(json, screen);
  if (screen?.blocked) withholdChatJson(json);
  return screen?.blocked ?? false;
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

export async function chatOnce(
  dep: ResolvedDeployment,
  group: ResolvedModelGroup,
  body: JsonMap,
  model: string,
): Promise<unknown> {
  const proxied = await proxyJson({
    dep,
    auth: await deploymentAuth(dep),
    path: "/chat/completions",
    body: { ...body, model: dep.model || plainModel(model), stream: false },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    groupStrategy: group.strategy,
  });
  if (!proxied.status || proxied.status >= 400) throw upstreamError(proxied.status, proxied.json, proxied.headers);
  return proxied.json;
}

export async function openUpstreamStream(input: {
  dep: ResolvedDeployment;
  group: ResolvedModelGroup;
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
      serviceModeHeaders(input.dep.kind, input.payload, input.group.strategy, input.dep.model, input.dep.facts),
    ),
    Accept: "text/event-stream",
  };
  if (input.form) delete headers["Content-Type"];
  const res = await fetch(joinPath(input.dep, input.path), {
    method: "POST",
    headers,
    body: input.form ?? JSON.stringify(withProject(input.dep, auth, input.payload)),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok || !res.body) {
    const text = await readTextOr(res);
    const json = parseJsonOrNull(text);
    if (json) throw upstreamError(res.status, json, res.headers);
    throw new GateError(res.status || 502, "upstream_error", text.slice(0, 512) || "upstream error");
  }
  return res;
}

export function openChatStream(
  dep: ResolvedDeployment,
  group: ResolvedModelGroup,
  input: { req: Request; model: string; body: JsonMap },
): Promise<Response> {
  const payload = prepareBody(
    dep,
    "/chat/completions",
    {
      ...input.body,
      model: dep.model || plainModel(input.model),
      stream: true,
      stream_options: { ...(asRecord(input.body.stream_options) ?? {}), include_usage: true },
    },
    group.strategy,
  );
  return openUpstreamStream({ dep, group, req: input.req, path: "/chat/completions", payload });
}

function streamTranslator(dep: ResolvedDeployment, model: string): ChatSseTranslator | null {
  if (speaksAnthropic(dep.kind)) return new AnthropicSseTranslator(model);
  if (dep.kind === "codex") return new CodexSseTranslator(model);
  if (dep.kind === "antigravity") return new AntigravitySseTranslator(model);
  return null;
}

export async function dispatchChat(input: {
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  outputGuard: OutputGuard | null;
  responseCache?: ResponseCacheUsage;
}): Promise<{ json: JsonMap; dep: ResolvedDeployment; alias: string; usage: Partial<TokenUsage>; cost: number }> {
  const started = Date.now();
  const routed = await routeMetered(input, started, (dep, group) => chatOnce(dep, group, input.body, input.model));
  const { result, dep, alias } = routed;

  const json: JsonMap = { ...(asRecord(result) ?? {}), model: input.model };
  const blocked = screenChatOutput(json, input.outputGuard, input.principal.trace);
  json.model = input.model;
  if (!json.object) json.object = "chat.completion";
  if (!json.id) json.id = `chatcmpl_${newId()}`;
  const usage = usageFromUnknown(json.usage, json);
  const cost = await recordSuccess(input, routed, {
    usage,
    blocked,
    started,
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
  outputGuard: OutputGuard | null;
}): Promise<Response> {
  const started = Date.now();
  const routed = await routeMetered(input, started, (dep, group) => openChatStream(dep, group, input), {
    deferRelease: true,
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
  group: ResolvedModelGroup;
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
  const reads = new DeadlineReader(reader);
  const translator = streamTranslator(dep, input.model);
  let leftover = "";
  let billed = false;
  let ended = false;
  let reported: Partial<TokenUsage> | null = null;
  let streamedText = "";
  let filtered = false;
  let emitted = 0;
  let closed = false;
  let lastSent = Date.now();

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    emitted += 1;
    lastSent = Date.now();
    controller.enqueue(chunk);
  };

  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    closed = true;
    controller.close();
  };

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
    await recordSuccess(input, { dep, group }, {
      usage: reported ?? {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      },
      blocked: screen?.blocked ?? false,
      started,
      stream: true,
      response: transcript.result(),
    });
  };

  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown) => {
    const message = err instanceof Error && err.message ? err.message : "upstream stream error";
    const gate = err instanceof GateError ? err : new GateError(502, "upstream_error", message);
    release();
    if (billed) return;
    billed = true;
    const errorChunk = encoder.encode(
      sseData({ error: { message: gate.message, type: gate.type, param: gate.param, code: gate.code } }),
    );
    try {
      send(controller, errorChunk);
      end(controller);
      close(controller);
    } catch {
      closed = true;
      controller.error(err);
    }
    await recordFailure(
      { principal: input.principal, model: input.model, body: input.body },
      gate,
      started,
    );
  };

  const forward = (json: JsonMap, controller: ReadableStreamDefaultController<Uint8Array>) => {
    screenChatJson(json, screen, true);
    json.model = input.model;
    if (screen?.blocked) {
      if (!filtered) {
        filtered = true;
        const stop = contentFilterChunk(json, input.model);
        transcript.push(stop);
        send(controller, encoder.encode(sseData(stop)));
      }
      json.choices = [];
      if (!asRecord(json.usage)) return;
    }
    if (observe(json)) send(controller, encoder.encode(sseData(json)));
  };

  const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ended) return;
    ended = true;
    send(controller, encoder.encode(sseData("[DONE]")));
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
          send(controller, encoder.encode(sseData(payload)));
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
      send(controller, encoder.encode(sseData(data)));
      return;
    }
    forward(json, controller);
  };

  const step = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const read = await reads.read(lastSent + KEEPALIVE_MS - Date.now());
    if (!read) {
      send(controller, encoder.encode(SSE_KEEPALIVE));
      return;
    }
    const { done, value } = read;
    if (done) {
      leftover += decoder.decode();
      if (leftover) {
        for (const line of leftover.split("\n")) emitLine(line, controller);
      }
      if (translator) {
        const flushed = translator.flush();
        if (flushed && flushed !== "[DONE]") {
          const json = parseJsonOrNull(flushed) as JsonMap | null;
          if (json) forward(json, controller);
        }
      }
      end(controller);
      close(controller);
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
      const before = emitted;
      try {
        while (emitted === before && !closed) await step(controller);
      } catch (err) {
        await fail(controller, err);
      }
    },
    cancel() {
      void cancelQuietly(reader);
      void finish();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
