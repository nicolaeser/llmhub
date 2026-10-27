import "server-only";
import { AnthropicSseTranslator } from "@/lib/gateway/protocols/anthropic";
import { recordUsage, recordUsageOrLog, usageFromUnknown } from "@/lib/gateway/billing/billing";
import { alertUpstreamFailure } from "@/lib/alerts/notify";
import { spendTag } from "@/lib/gateway/access/gate";
import { CLIENT_CLOSED_STATUS, clientClosedError, GateError, isClientClosed } from "@/lib/gateway/errors";
import { outputScreen, type OutputScreen } from "@/lib/gateway/safety/guardrails";
import { instructChat } from "@/lib/gateway/safety/pii-instruction";
import { requestRoutingOverride, serviceModeHeaders, variantRoutes } from "@/lib/gateway/dispatch/service-mode";
import { accessOf } from "@/lib/gateway/routing/account-access";
import { pinsAccounts, runSession, writePin } from "@/lib/gateway/routing/account-affinity";
import {
  dropAccountReasoning,
  historyLength,
  nextPin,
  rejectsForeignReasoning,
} from "@/lib/gateway/routing/account-handoff";
import {
  acquireGroup,
  loadGroup,
  markFailure,
  markLimited,
  markOverloaded,
  markRejected,
  markSuccess,
  permittedDeployments,
} from "@/lib/gateway/routing/runtime";
import { isSignInKind, speaksAnthropic, speaksGoogle, speaksMuse } from "@/lib/gateway/upstreams/provider-kinds";
import { AntigravitySseTranslator } from "@/lib/gateway/upstreams/antigravity";
import { googleStreamTranslator } from "@/lib/gateway/upstreams/google";
import { CodexSseTranslator } from "@/lib/gateway/upstreams/codex";
import { devinEventStream, devinHttpError } from "@/lib/gateway/upstreams/devin";
import { museTranslator } from "@/lib/gateway/upstreams/muse";
import { deploymentAuth, renewRejectedLogin } from "@/lib/gateway/upstreams/credentials";
import { nudgeLimits, recordStreamTraffic } from "@/lib/gateway/upstreams/limit-store";
import { autoRedeemIfDue } from "@/lib/gateway/upstreams/reset-redeem";
import { plainModel } from "@/lib/gateway/catalog/model-alias";
import { hiddenFrom, outsidePool, routable, routeOf } from "@/lib/gateway/routing/route-pool";
import { ContextFit, contextOverflow } from "@/lib/gateway/routing/context-window";
import { KEEPALIVE_MS, SSE_HEADERS, SSE_KEEPALIVE, sseData } from "@/lib/gateway/protocols/sse";
import {
  devinResetLookup,
  joinPath,
  mergeUpstreamHeaders,
  museUsageObserver,
  observeUpstreamLimits,
  observeUpstreamStatus,
  prepareBody,
  proxyJson,
  retryableStatus,
  streamAccept,
  upstreamBody,
  upstreamError,
  upstreamHeaders,
  upstreamModel,
  upstreamRetryAt,
} from "@/lib/gateway/dispatch/upstream";
import { asRecord, ERR_UNKNOWN_GROUP, isRouterError, isUnavailableError, newId, routerGateError, stringifyContent } from "@/lib/gateway/core";
import { costFilter, costRejected } from "@/lib/gateway/billing/cost-cap";
import { ChatStreamTranscript } from "@/lib/gateway/request-logs/log-content";
import { contextDemand, estimateTokens, requestText } from "@/lib/gateway/billing/tokens";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull, readTextOr } from "@/lib/utils/json";
import { cancelQuietly, DeadlineReader, withIdleTimeout } from "@/lib/utils/streams";
import type { ChatSseTranslator, JsonMap, Principal, RequestTrace } from "@/types/gateway";
import type { CostFilter, TokenUsage } from "@/types/billing";
import type {
  AccountPin,
  ResolvedModelGroup,
  ResolvedDeployment,
  RouteEntry,
  RoutePool,
  RunRouting,
} from "@/types/routing";
import type { SignInKind } from "@/types/providers";
import type { OutputGuard } from "@/types/guardrails";
import type { RouteLimits } from "@/types/model-templates";
import type { ResponseCacheUsage } from "@/types/cache";

export const UPSTREAM_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const ACCOUNT_REJECTED_COOLDOWN_MS = 30 * 60_000;
const MODEL_UNAVAILABLE_COOLDOWN_MS = 60 * 60_000;
const OVERLOADED_STATUS = 529;
const ACCOUNT_REJECTED_STATUSES = new Set([401, 402, 403]);
const MODEL_UNAVAILABLE = /\bmodel\b/i;

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
    outcome: isClientClosed(err) ? "cancelled" : "error",
    latencyMs: Date.now() - started,
    tag: spendTag(input.body),
    request: input.body,
    error: err,
  });
}

type MeteredCall = {
  principal: Principal;
  model: string;
  body: JsonMap;
  aliases: string[];
  headers?: Record<string, string>;
};

export async function routeMetered<T>(
  input: MeteredCall,
  started: number,
  fn: (dep: ResolvedDeployment, group: ResolvedModelGroup) => Promise<T>,
  opts: { deferRelease?: boolean; signal?: AbortSignal } = {},
) {
  const routing = {
    ...opts,
    strategy: requestRoutingOverride(input.body),
    principal: input.principal,
    cost: costFilter(input.principal, input.body),
    request: input.body,
    headers: input.headers,
    fitContext: true,
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
    hungUp?: boolean;
    responseCache?: ResponseCacheUsage;
  },
): Promise<number> {
  if (routed.dep.provider) recordStreamTraffic(routed.dep.provider.id);
  return recordUsage({
    principal: input.principal,
    model: input.model,
    deployment: routed.dep,
    group: routed.group,
    usage: outcome.usage,
    status: outcome.hungUp ? CLIENT_CLOSED_STATUS : 200,
    outcome: outcome.blocked ? "guardrail_blocked" : outcome.hungUp ? "cancelled" : "ok",
    latencyMs: Date.now() - outcome.started,
    tag: spendTag(input.body),
    stream: outcome.stream,
    request: input.body,
    response: outcome.response,
    responseCache: outcome.responseCache,
  });
}

function fallbackable(err: unknown): boolean {
  if (isRouterError(err)) return true;
  if (err instanceof GateError) return retryableStatus(err.status) && !err.requestScoped;
  return true;
}

function signInAccount(dep: ResolvedDeployment): string | null {
  return dep.provider && isSignInKind(dep.provider.kind) ? dep.provider.id : null;
}

function pinnedAccount(dep: ResolvedDeployment): string | null {
  return dep.provider && pinsAccounts(dep.provider.kind) ? dep.provider.id : null;
}

type FailureClass =
  | "request"
  | "context"
  | "limit"
  | "rejected"
  | "signed_out"
  | "model"
  | "overloaded"
  | "transient"
  | "caller";

function failureClass(err: unknown, account: string | null): FailureClass {
  if (!(err instanceof GateError)) return "transient";
  if (err.requestScoped) return "request";
  if (contextOverflow(err)) return "context";
  if (err.status === 429) return "limit";
  if (err.status === OVERLOADED_STATUS) return "overloaded";
  if (account && ACCOUNT_REJECTED_STATUSES.has(err.status)) return "rejected";
  if (account && err.code === "no_provider_key") return "signed_out";
  if (account && err.status === 404 && MODEL_UNAVAILABLE.test(err.message)) return "model";
  return retryableStatus(err.status) ? "transient" : "caller";
}

function recordAttemptFailure(dep: ResolvedDeployment, failure: FailureClass, err: unknown, now = Date.now()): void {
  if (failure === "caller" || failure === "request" || failure === "context") return;
  if (failure === "overloaded") markOverloaded(dep);
  else if (failure === "rejected") markRejected(dep, now + ACCOUNT_REJECTED_COOLDOWN_MS);
  else if (failure === "model") markRejected(dep, now + MODEL_UNAVAILABLE_COOLDOWN_MS);
  else if (failure === "limit") markLimited(dep, err instanceof GateError ? err.retryAt : null, now);
  else markFailure(dep, err instanceof GateError ? err.retryAt : null);
}

function rotatesAccount(failure: FailureClass): boolean {
  return failure === "limit" || failure === "rejected" || failure === "signed_out" || failure === "model";
}

function unauthorized(err: unknown): boolean {
  return err instanceof GateError && err.status === 401;
}

function accountBudget(deployments: ResolvedDeployment[]): number {
  return new Set(deployments.flatMap((dep) => signInAccount(dep) ?? [])).size;
}

async function settleRunPin(
  kind: string,
  session: string,
  account: string,
  pinned: AccountPin | null,
  switched: boolean,
  request: JsonMap | null,
): Promise<void> {
  const held = await writePin(kind, session, nextPin(account, pinned, switched, historyLength(request)), pinned);
  if (!pinned || pinned.providerId === account || held?.providerId !== account) return;
  logger.info("gateway.account_handover", { kind, from: pinned.providerId, to: account, failover: switched });
}

function carriesAccountReasoning(kind: string): boolean {
  return kind === "codex" || kind === "muse_code";
}

function prepareHandoff(dep: ResolvedDeployment, pinned: AccountPin | null, switched: boolean, request: JsonMap | null): void {
  if (!request || !carriesAccountReasoning(dep.kind)) return;
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
    headers?: Record<string, string>;
    signal?: AbortSignal;
    health?: boolean;
    fitContext?: boolean;
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
  const tracksHealth = opts?.health !== false;
  const run: RunRouting = { session: runSession(request, opts?.headers), tried: new Set() };
  const renewed = new Set<string>();
  const context =
    opts?.fitContext && request
      ? new ContextFit(() => contextDemand(request), {
          keyId: opts.principal?.key?.token_id ?? "",
          endpoint: opts.principal?.trace?.endpoint ?? "",
        })
      : null;
  let reasoningDropped = false;
  let failedAccount: string | null = null;
  let upstreamTried = false;
  let overflow: unknown = null;
  const queue: RouteEntry[] = aliases.map((entry) => {
    const route = routeOf(entry, surface);
    return { alias: route.alias, root: route.alias, pool: route.pool, relaxed: false, estimated: false };
  });
  const deferred: RouteEntry[] = [];
  const entryAt = (index: number): RouteEntry | undefined => {
    if (index === queue.length) queue.push(...deferred.splice(0));
    return queue[index];
  };
  for (let qi = 0; entryAt(qi); qi++) {
    const { alias, root, pool, relaxed, estimated } = queue[qi]!;
    let group: ResolvedModelGroup;
    try {
      group = await loadGroup(alias);
    } catch (err) {
      last = err;
      continue;
    }
    if (hiddenFrom(pool, group.mapped)) {
      last = ERR_UNKNOWN_GROUP;
      continue;
    }
    const inPool = routable(pool);
    const pooled = group.mapped.filter(inPool);
    const variants = variantRoutes(pooled, opts?.request);
    const candidates = context ? permittedDeployments(pooled, limits[root]).filter(variants.serves) : [];
    const plan = context && !estimated ? context.plan(candidates, relaxed) : "open";
    if (plan !== "open") context!.record(plan, alias, candidates);
    if (plan === "tight") deferred.push({ alias, root, pool, relaxed: true, estimated: false });
    const sized = plan === "open" || plan === "narrowed";
    const estimating = Boolean(context) && sized && !estimated && context!.estimates(candidates);
    const doubted = estimating ? context!.doubted(candidates, relaxed) : [];
    if (doubted.length) context!.record("deferred", alias, doubted);
    if (estimating) deferred.push({ alias, root, pool, relaxed, estimated: true });
    const servable = (dep: ResolvedDeployment) =>
      inPool(dep) && variants.serves(dep) && (!context || context.serves(dep, relaxed, estimated));
    const spills = Boolean(group.overflow_group) && !estimated && !doubted.length;
    const reachable = sized && (!group.mapped.length || group.mapped.some(servable) || spills);
    if (sized && !reachable && !estimated && !doubted.length) {
      last = pooled.length && variants.error ? variants.error : outsidePool(pool, surface);
    }
    const attempts = reachable ? Math.max(0, group.num_retries) + 1 : 0;
    const switchBudget = accountBudget(pooled.filter(servable));
    let switches = 0;
    let stopAlias = false;
    for (let i = 0; i < attempts; i++) {
      if (opts?.signal?.aborted) throw clientClosedError();
      try {
        const acquired = await acquireGroup(group, limits[root], servable, opts?.strategy, opts?.cost, access, run);
        const account = signInAccount(acquired.dep);
        const switched = account !== null && failedAccount !== null && failedAccount !== account;
        prepareHandoff(acquired.dep, acquired.pinned, switched, request);
        try {
          const started = Date.now();
          upstreamTried = true;
          const result = await fn(acquired.dep, group);
          if (tracksHealth) markSuccess(acquired.dep, Date.now() - started);
          const pinTo = pinnedAccount(acquired.dep);
          if (pinTo && run.session && !acquired.pinHeld) {
            void settleRunPin(acquired.dep.provider!.kind, run.session, pinTo, acquired.pinned, switched, request);
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
          if (opts?.signal?.aborted) throw clientClosedError();
          if (account && unauthorized(err) && !renewed.has(account)) {
            renewed.add(account);
            if (await renewRejectedLogin(account, acquired.dep.provider!.kind as SignInKind)) {
              i--;
              continue;
            }
          }
          if (
            !reasoningDropped &&
            carriesAccountReasoning(acquired.dep.kind) &&
            rejectsForeignReasoning(err) &&
            dropAccountReasoning(request)
          ) {
            reasoningDropped = true;
            i--;
            continue;
          }
          const failure = failureClass(err, account);
          if (failure === "request") throw err;
          if (tracksHealth) recordAttemptFailure(acquired.dep, failure, err);
          last = err;
          if (!isRouterError(err)) upstreamFailure = err;
          if (failure === "context") {
            overflow = err;
            run.tried.add(acquired.dep.id);
            context?.overflowed(acquired.dep);
            context?.record("overflow", alias, [acquired.dep]);
            continue;
          }
          if (account && tracksHealth && failure === "limit") {
            nudgeLimits(account, acquired.dep.provider!.kind);
            void autoRedeemIfDue(account);
          }
          if (account && rotatesAccount(failure)) {
            run.tried.add(acquired.dep.id);
            failedAccount = account;
            if (switches < switchBudget) {
              switches++;
              i--;
            }
            continue;
          }
          if (failure === "caller") {
            stopAlias = true;
            if (!fallbackable(err)) throw err;
            break;
          }
        }
      } catch (err) {
        last = err;
        if (isClientClosed(err) || !fallbackable(err) || costRejected(err)) throw err;
        break;
      }
    }
    for (const fb of group.fallback_groups) {
      if (!queue.some((entry) => entry.alias === fb && entry.pool === pool)) {
        queue.push({ alias: fb, root, pool, relaxed: false, estimated: false });
      }
    }
    if (
      !stopAlias &&
      group.overflow_group &&
      !queue.some((entry) => entry.alias === group.overflow_group && entry.pool === pool)
    ) {
      queue.push({ alias: group.overflow_group, root, pool, relaxed: false, estimated: false });
    }
  }
  const waiting = isUnavailableError(last) && last.wait !== null;
  let failure = upstreamFailure && isUnavailableError(last) && !last.wait?.limited ? upstreamFailure : last;
  if (context?.short && !upstreamTried && !waiting) {
    failure = context.rejection(aliases[0] ?? "");
    context.record("rejected", aliases[0] ?? "", []);
  } else if (overflow && isRouterError(failure)) {
    failure = overflow;
  }
  if (tracksHealth) await alertUpstreamFailure(failure);
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
  if (!proxied.status || proxied.status >= 400) {
    if (dep.kind === "devin") throw devinHttpError(proxied.status, new TextDecoder().decode(proxied.raw), devinResetLookup(dep));
    throw upstreamError(proxied.status, proxied.json, proxied.headers);
  }
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
  timeouts?: { headersMs?: number; idleMs?: number };
}): Promise<Response> {
  const auth = await deploymentAuth(input.dep);
  const headersDue = new AbortController();
  const headersTimer = setTimeout(
    () => headersDue.abort(new DOMException("upstream response headers timed out", "TimeoutError")),
    input.timeouts?.headersMs ?? UPSTREAM_TIMEOUT_MS,
  );
  const signals: AbortSignal[] = [headersDue.signal];
  if (input.req.signal) signals.push(input.req.signal);
  const headers: Record<string, string> = {
    ...mergeUpstreamHeaders(
      upstreamHeaders(input.dep, auth, input.headers),
      serviceModeHeaders(input.dep.kind, input.payload, input.group.strategy, input.dep.model, input.dep.facts),
    ),
    Accept: streamAccept(input.dep.kind),
  };
  if (input.form) delete headers["Content-Type"];
  try {
    const res = await fetch(joinPath(input.dep, input.path, upstreamModel(input.dep, input.payload)), {
      method: "POST",
      headers,
      body: input.form ?? upstreamBody(input.dep, auth, input.path, input.payload),
      signal: AbortSignal.any(signals),
    });
    observeUpstreamLimits(input.dep, res.headers);
    observeUpstreamStatus(input.dep, res.status);
    if (!res.ok || !res.body) {
      const text = await readTextOr(res);
      if (input.dep.kind === "devin") throw devinHttpError(res.status, text, devinResetLookup(input.dep));
      const json = parseJsonOrNull(text);
      if (json) throw upstreamError(res.status, json, res.headers);
      throw new GateError(res.status || 502, "upstream_error", text.slice(0, 512) || "upstream error", {
        retryAt: upstreamRetryAt(res.status, null, Date.now(), res.headers),
      });
    }
    const body = withIdleTimeout(
      res.body,
      input.timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS,
      () => new GateError(504, "upstream_timeout", "upstream stream stalled"),
    );
    const live = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    if (input.dep.kind === "devin") return devinEventStream(live, input.dep.model, devinResetLookup(input.dep));
    return live;
  } finally {
    clearTimeout(headersTimer);
  }
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
  if (speaksMuse(dep.kind)) return museTranslator(model, museUsageObserver(dep));
  if (dep.kind === "antigravity") return new AntigravitySseTranslator(model);
  if (speaksGoogle(dep.kind)) return googleStreamTranslator(dep.kind, dep.model || plainModel(model), model);
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
  const call = { ...input, body: instructChat(input.principal.trace, input.body) };
  const routed = await routeMetered(call, started, (dep, group) => chatOnce(dep, group, call.body, call.model));
  const { result, dep, alias } = routed;

  const json: JsonMap = { ...(asRecord(result) ?? {}), model: input.model };
  const blocked = screenChatOutput(json, input.outputGuard, input.principal.trace);
  json.model = input.model;
  if (!json.object) json.object = "chat.completion";
  if (!json.id) json.id = `chatcmpl_${newId()}`;
  const usage = usageFromUnknown(json.usage, json);
  const cost = await recordSuccess(call, routed, {
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
  const call = { ...input, body: instructChat(input.principal.trace, input.body) };
  const routed = await routeMetered(call, started, (dep, group) => openChatStream(dep, group, call), {
    deferRelease: true,
    signal: input.req.signal,
  });
  return relayChatStream({
    res: routed.result,
    dep: routed.dep,
    group: routed.group,
    release: routed.release,
    principal: call.principal,
    model: call.model,
    body: call.body,
    outputGuard: call.outputGuard,
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
  let completed = false;
  let lastSent = Date.now();

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    emitted += 1;
    lastSent = Date.now();
    if (dep.provider) recordStreamTraffic(dep.provider.id, lastSent);
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
      if (asRecord(choice)?.finish_reason) completed = true;
    }
    if (!wantsUsage) {
      delete json.usage;
      if (usage && choices.length === 0) return false;
    }
    return true;
  };

  const finish = async (hungUp = false) => {
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
      hungUp: hungUp && !completed,
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
        completed = true;
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
          completed = true;
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
      completed = true;
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
      if (!completed) throw new GateError(502, "upstream_error", "upstream stream ended before the response was complete");
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
      void finish(true);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
