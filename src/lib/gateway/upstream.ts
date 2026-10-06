import "server-only";
import { env } from "@/lib/env";
import { GateError } from "@/lib/gateway/errors";
import { anthropicToChat, chatToAnthropic } from "@/lib/gateway/anthropic";
import {
  acquireGroup,
  defaultBase,
  loadGroup,
  markFailure,
  markSuccess,
  openaiRoot,
  secretFor,
} from "@/lib/gateway/runtime";
import { applyProviderServiceMode, requestRoutingOverride, serviceModeHeaders } from "@/lib/gateway/service-mode";
import { asRecord } from "@/lib/gateway/core";
import type { ResolvedDeployment, JsonMap, ProxyFirstResult } from "@/types/gateway";

export function upstreamHeaders(
  dep: ResolvedDeployment,
  apiKey: string,
  extra?: HeadersInit,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (dep.kind === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (dep.kind === "openrouter" || dep.kind === "openrouter_eu") {
    headers["HTTP-Referer"] = env.NEXT_PUBLIC_APP_URL;
    headers["X-Title"] = "LLM Hub";
  }
  if (extra) {
    const src = extra instanceof Headers ? extra : new Headers(extra);
    src.forEach((value, key) => {
      if (!["host", "content-length", "connection", "authorization"].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });
  }
  return headers;
}

export function mergeUpstreamHeaders(
  ...sets: Record<string, string>[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of sets) {
    for (const [key, value] of Object.entries(set)) {
      const existing = out[key];
      if (key.toLowerCase() === "anthropic-beta" && existing) {
        const values = new Set(
          `${existing},${value}`
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        );
        out[key] = [...values].join(",");
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function nativeChatPath(path: string): boolean {
  return path.includes("chat/completions");
}

const XAI_EFFORT_MIN_VERSION = 4.5;
const XAI_XHIGH_MIN_VERSION = 4.6;
const GATEWAY_ONLY_KEYS = ["fallbacks", "fallback", "tags", "tag"] as const;

function withoutThinkingBlocks(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((raw) => {
    const message = asRecord(raw);
    if (!message || !("thinking_blocks" in message)) return raw;
    const copy = { ...message };
    delete copy.thinking_blocks;
    return copy;
  });
}

export function joinPath(dep: ResolvedDeployment, rel: string): string {
  const root = openaiRoot(defaultBase(dep));
  const path = rel.startsWith("/") ? rel : `/${rel}`;
  if (dep.kind === "anthropic") {
    if (path === "/chat/completions" || path === "/v1/chat/completions") {
      return `${root.replace(/\/v1$/, "")}/v1/messages`;
    }
    if (path.startsWith("/v1/")) return `${root.replace(/\/v1$/, "")}${path}`;
    return `${root.replace(/\/v1$/, "")}/v1${path}`;
  }
  if (path.startsWith("/v1/")) {
    return `${root.replace(/\/v1$/, "")}${path}`;
  }
  return `${root}${path}`;
}

export function xaiReasoningEffort(model: string, effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  const match = /grok-(\d+)(?:[.-](\d)(?![0-9]))?/i.exec(model);
  const version = match ? Number(match[1]) + Number(match[2] ?? 0) / 10 : 0;
  if (version < XAI_EFFORT_MIN_VERSION) return effort;
  const xhigh = version >= XAI_XHIGH_MIN_VERSION;
  if (effort === "none" || effort === "minimal") return "low";
  if (effort === "max" || effort === "xhigh") return xhigh ? "xhigh" : "high";
  return effort;
}

export function prepareBody(
  dep: ResolvedDeployment,
  path: string,
  body: JsonMap,
  groupStrategy = "",
): JsonMap {
  let payload: JsonMap = { ...body, model: dep.model || body.model };
  for (const key of GATEWAY_ONLY_KEYS) delete payload[key];
  payload = applyProviderServiceMode(dep.kind, payload, groupStrategy).body;
  if (dep.kind === "xai" && payload.reasoning_effort !== undefined) {
    payload.reasoning_effort = xaiReasoningEffort(String(payload.model ?? ""), payload.reasoning_effort);
  }
  if (dep.kind !== "anthropic" && Array.isArray(payload.messages)) {
    payload.messages = withoutThinkingBlocks(payload.messages);
  }
  if (dep.kind === "anthropic" && nativeChatPath(path)) {
    const converted = chatToAnthropic(payload);
    if (typeof payload.speed === "string") converted.speed = payload.speed;
    if (typeof payload.service_tier === "string") {
      converted.service_tier = payload.service_tier;
    }
    return converted;
  }
  return payload;
}

function decodeBody(
  dep: ResolvedDeployment,
  path: string,
  json: unknown,
  model: string,
): unknown {
  if (dep.kind === "anthropic" && nativeChatPath(path)) {
    const rec = asRecord(json);
    if (rec && rec.type === "message") return anthropicToChat(rec, model);
  }
  return json;
}

export async function proxyJson(input: {
  dep: ResolvedDeployment;
  apiKey: string;
  method?: string;
  path: string;
  body?: JsonMap | null;
  timeoutMs?: number;
  rawBody?: BodyInit | null;
  contentType?: string;
  groupStrategy?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; json: unknown; headers: Headers; raw: Uint8Array }> {
  const method = input.method ?? "POST";
  const url = joinPath(input.dep, input.path);
  const headers = mergeUpstreamHeaders(
    upstreamHeaders(input.dep, input.apiKey, input.headers),
    serviceModeHeaders(input.dep.kind, input.body ?? {}, input.groupStrategy, input.dep.model),
  );
  if (input.rawBody instanceof FormData) {
    delete headers["Content-Type"];
  } else if (input.contentType) {
    headers["Content-Type"] = input.contentType;
  }
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 120_000),
  };
  if (input.rawBody != null) {
    init.body = input.rawBody;
  } else if (input.body && method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(
      prepareBody(input.dep, input.path, input.body, input.groupStrategy),
    );
  }
  const res = await fetch(url, init);
  const raw = new Uint8Array(await res.arrayBuffer());
  let json: unknown = {};
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      json = {};
    }
  }
  json = decodeBody(input.dep, input.path, json, input.dep.model);
  return { status: res.status, json, headers: res.headers, raw };
}

async function proxyRaw(input: {
  dep: ResolvedDeployment;
  apiKey: string;
  method?: string;
  path: string;
  body?: JsonMap | null;
  rawBody?: BodyInit | null;
  contentType?: string;
  timeoutMs?: number;
  groupStrategy?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; raw: Uint8Array; contentType: string; headers: Headers }> {
  const method = input.method ?? "POST";
  const url = joinPath(input.dep, input.path);
  const headers = mergeUpstreamHeaders(
    upstreamHeaders(input.dep, input.apiKey, input.headers),
    serviceModeHeaders(input.dep.kind, input.body ?? {}, input.groupStrategy, input.dep.model),
  );
  if (input.rawBody instanceof FormData) {
    delete headers["Content-Type"];
  } else if (input.contentType) {
    headers["Content-Type"] = input.contentType;
  }
  const res = await fetch(url, {
    method,
    headers,
    body:
      input.rawBody ??
      (input.body && method !== "GET"
        ? JSON.stringify(
            prepareBody(input.dep, input.path, input.body, input.groupStrategy),
          )
        : undefined),
    signal: AbortSignal.timeout(input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 120_000),
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    raw,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    headers: res.headers,
  };
}

export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function detailMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;
  const rec = asRecord(detail);
  if (rec && typeof rec.message === "string") return rec.message;
  if (!Array.isArray(detail)) return "";
  return detail
    .map((item) => {
      const entry = asRecord(item);
      if (!entry || typeof entry.msg !== "string") return "";
      const loc = Array.isArray(entry.loc) ? entry.loc.map(String).join(".") : "";
      return loc ? `${loc}: ${entry.msg}` : entry.msg;
    })
    .filter(Boolean)
    .join("; ");
}

export function upstreamErrorMessage(status: number, json: unknown): string {
  const rec = asRecord(json);
  const error = asRecord(rec?.error);
  return (
    (typeof error?.message === "string" && error.message) ||
    (typeof rec?.error === "string" && rec.error) ||
    detailMessage(rec?.detail) ||
    (typeof rec?.message === "string" && rec.message) ||
    `upstream returned ${status}`
  );
}

export function upstreamError(status: number, json: unknown): GateError {
  const error = asRecord(asRecord(json)?.error);
  const passCode = status !== 401 && status !== 403 && typeof error?.code === "string" && error.code;
  return new GateError(status || 502, "upstream_error", upstreamErrorMessage(status, json), {
    param: typeof error?.param === "string" ? error.param : null,
    upstreamCode: passCode || undefined,
  });
}

export function withDeploymentModel(raw: BodyInit | undefined, model: string): BodyInit | undefined {
  if (!(raw instanceof FormData) || !model) return raw;
  const form = new FormData();
  for (const [key, value] of raw.entries()) form.append(key, value);
  form.set("model", model);
  return form;
}

export async function forwardToModel(
  aliases: string[],
  path: string,
  body: JsonMap | null,
  opts?: {
    method?: string;
    rawBody?: BodyInit;
    contentType?: string;
    binary?: boolean;
    headers?: Record<string, string>;
  },
): Promise<ProxyFirstResult> {
  let last: GateError = new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  for (const alias of aliases) {
    if (!alias || alias === "auto") continue;
    let group;
    try {
      group = await loadGroup(alias);
    } catch {
      continue;
    }
    const attempts = Math.max(0, group.num_retries) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let acquired;
      try {
        acquired = await acquireGroup(group, undefined, requestRoutingOverride(body));
      } catch {
        last = new GateError(503, "no_healthy_deployment", "no healthy deployment for model");
        break;
      }
      const { dep, release } = acquired;
      try {
        const apiKey = secretFor(dep);
        if (!apiKey && dep.kind !== "openai_compat") {
          last = new GateError(503, "no_provider_key", "no API key for deployment");
          break;
        }
        const started = Date.now();
        const request = {
          dep,
          apiKey,
          path,
          body,
          rawBody: withDeploymentModel(opts?.rawBody, dep.model),
          contentType: opts?.contentType,
          method: opts?.method,
          groupStrategy: group.strategy,
          headers: opts?.headers,
        };
        const proxied = opts?.binary
          ? { ...(await proxyRaw(request)), json: {} as unknown }
          : await proxyJson(request);
        if (proxied.status < 400) {
          markSuccess(dep, Date.now() - started);
          return {
            status: proxied.status,
            json: proxied.json,
            raw: proxied.raw,
            contentType:
              proxied.headers.get("content-type") ??
              (opts?.binary ? "application/octet-stream" : "application/json"),
            depId: dep.id,
            alias,
            dep,
            group,
          };
        }
        const json = opts?.binary
          ? (() => {
              try {
                return JSON.parse(new TextDecoder().decode(proxied.raw)) as unknown;
              } catch {
                return null;
              }
            })()
          : proxied.json;
        last = upstreamError(proxied.status, json);
        if (!retryableStatus(proxied.status)) throw last;
        markFailure(dep);
      } catch (err) {
        if (err instanceof GateError && !retryableStatus(err.status)) throw err;
        markFailure(dep);
        last = err instanceof GateError ? err : new GateError(502, "upstream_error", "upstream request failed");
      } finally {
        release();
      }
    }
  }
  throw last;
}
