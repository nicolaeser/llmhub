import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordedPrisma } from "./recorded-prisma";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { GuardrailPolicy, PiiPolicy } from "@/types/guardrails";

export type UpstreamCall = { url: string; body: JsonMap | null; headers: Record<string, string> };

export type OverrideTarget = { orgId?: string; teamId?: string; projectId?: string; keyId?: string };

export type OverrideRow = {
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  keyId: string | null;
  pii: unknown;
  injection: unknown;
  secrets: unknown;
  rules: unknown;
};

export type OverridePolicies = {
  pii?: PiiPolicy | null;
  guardrails?: GuardrailPolicy | null;
  injection?: GuardrailPolicy["injection"] | null;
  secrets?: GuardrailPolicy["secrets"] | null;
  rules?: GuardrailPolicy["rules"] | null;
};
type RouteModule = { POST(req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> };

export const API_KEY = "sk-hub-test";
export const MODEL = "gpt-test";
export const UPSTREAM = "https://upstream.test/v1";
export const VIDEO_ID = "video-1";

export function virtualKeyRow(change: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    prefix: API_KEY,
    keyAlias: "test",
    userId: "user-1",
    teamId: null,
    orgId: null,
    projectId: null,
    memberId: null,
    models: [] as string[],
    maxBudget: 0,
    spend: 0,
    rpmLimit: 0,
    tpmLimit: 0,
    maxRequestCost: 0,
    budgetDuration: "",
    expiresAt: null,
    allowedIps: [],
    allowedEndpoints: [],
    accessWindows: [],
    accessTimeZone: "UTC",
    blocked: false,
    paused: false,
    pausedUntil: null,
    logContent: false,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    templates: [],
    ...change,
  };
}

export function groupRow(alias: string, change: Record<string, unknown> = {}) {
  return {
    alias,
    enabled: true,
    vendor: "openai",
    displayName: "",
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    autoRoutes: null,
    deployments: [
      {
        id: `${alias}-route`,
        kind: "openai_compat",
        baseUrl: UPSTREAM,
        model: alias,
        weight: 1,
        costInput: 0,
        costOutput: 0,
        providerId: null,
        provider: null,
      },
    ],
    ...change,
  };
}

export function chatReply(content: string): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function defaultReply(call: UpstreamCall): Response {
  if (call.url.endsWith("/chat/completions")) return chatReply("ok");
  if (call.url.endsWith("/embeddings")) {
    return Response.json({ object: "list", data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
  }
  return Response.json({ id: "upstream-1", object: "ok" });
}

export const gateway = {
  upstream: [] as UpstreamCall[],
  enterprise: {} as JsonMap,
  key: virtualKeyRow(),
  overrides: [] as OverrideRow[],
  groups: new Map<string, unknown>([[MODEL, groupRow(MODEL)]]),
  reply: defaultReply as (call: UpstreamCall) => Response | Promise<Response>,
};

export function resetGateway(): void {
  recordedPrisma.reset();
  gateway.upstream.length = 0;
  gateway.enterprise = {};
  gateway.key = virtualKeyRow();
  gateway.overrides = [];
  gateway.reply = defaultReply;
}

export function overrideRow(target: OverrideTarget, policies: OverridePolicies): OverrideRow {
  return {
    orgId: target.orgId ?? null,
    teamId: target.teamId ?? null,
    projectId: target.projectId ?? null,
    keyId: target.keyId ?? null,
    pii: policies.pii ?? null,
    injection: policies.injection ?? policies.guardrails?.injection ?? null,
    secrets: policies.secrets ?? policies.guardrails?.secrets ?? null,
    rules: policies.rules ?? policies.guardrails?.rules ?? null,
  };
}

function sameOverrideTarget(a: OverrideRow, b: OverrideRow): boolean {
  return a.orgId === b.orgId && a.teamId === b.teamId && a.projectId === b.projectId && a.keyId === b.keyId;
}

export function setOverride(target: OverrideTarget, policies: OverridePolicies): void {
  const row = overrideRow(target, policies);
  gateway.overrides = [...gateway.overrides.filter((other) => !sameOverrideTarget(other, row)), row];
}

export function setKeyOverride(policies: OverridePolicies): void {
  setOverride({ keyId: gateway.key.id }, policies);
}

export function clearOverride(target: OverrideTarget): void {
  const row = overrideRow(target, {});
  gateway.overrides = gateway.overrides.filter((other) => !sameOverrideTarget(other, row));
}

function matchesWhere(row: OverrideRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, value]) => row[field as keyof OverrideRow] === value);
}

recordedPrisma.base = {
  virtualKey: { findFirst: () => gateway.key },
  policyOverride: {
    findMany: ({ where }: { where?: { OR?: Record<string, unknown>[] } } = {}) =>
      gateway.overrides.filter((row) => !where?.OR || where.OR.some((condition) => matchesWhere(row, condition))),
  },
  user: {
    findUnique: ({ where }: { where: { id: string } }) =>
      where.id === gateway.key.userId
        ? { id: where.id, blocked: false, orgId: null, spend: 0, maxBudget: 0, budgetDuration: "", spendResetAt: null, createdAt: new Date(0) }
        : null,
  },
  setting: {
    findUnique: ({ where }: { where: { key: string } }) =>
      where.key === "enterprise" ? { key: where.key, value: JSON.stringify(gateway.enterprise) } : null,
  },
  modelGroup: {
    findUnique: ({ where }: { where: { alias: string } }) => gateway.groups.get(where.alias) ?? null,
    findMany: ({ where }: { where?: { alias?: { in: string[] } } } = {}) =>
      [...gateway.groups.entries()].filter(([alias]) => !where?.alias || where.alias.in.includes(alias)).map(([, row]) => row),
  },
  storedObject: {
    findUnique: ({ where }: { where: { id: string } }) =>
      where.id === VIDEO_ID
        ? {
            id: VIDEO_ID,
            kind: "video",
            owner: gateway.key.id,
            filename: "",
            purpose: "",
            contentType: "application/json",
            bytes: 2,
            payload: Buffer.from("{}"),
            meta: { model: MODEL, upstream_id: "upstream-video" },
            createdAt: new Date(0),
          }
        : null,
  },
};

delete process.env.REDIS_URL;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? (parseJsonOrNull(init.body) as JsonMap | null) : null;
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const call = { url: input instanceof Request ? input.url : String(input), body, headers };
  gateway.upstream.push(call);
  return gateway.reply(call);
}) as typeof fetch;

export function gatewayRequest(urlPath: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://hub.local${urlPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export type ModelRoute = {
  path: string;
  load: () => Promise<RouteModule>;
  body: (text: string) => JsonMap;
  params?: Record<string, string>;
};

const chat = (text: string): JsonMap => ({ model: MODEL, messages: [{ role: "user", content: text }] });
const anthropic = (text: string): JsonMap => ({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: text }] });
const input = (text: string): JsonMap => ({ model: MODEL, input: text });
const prompt = (text: string): JsonMap => ({ model: MODEL, prompt: text });

export const MODEL_ROUTES: ModelRoute[] = [
  { path: "/api/v1/chat/completions", load: () => import("@/app/api/v1/chat/completions/route"), body: chat },
  { path: "/api/v1/completions", load: () => import("@/app/api/v1/completions/route"), body: prompt },
  { path: "/api/v1/messages", load: () => import("@/app/api/v1/messages/route"), body: anthropic },
  { path: "/api/v1/messages/count_tokens", load: () => import("@/app/api/v1/messages/count_tokens/route"), body: anthropic },
  { path: "/api/v1/responses", load: () => import("@/app/api/v1/responses/route"), body: input },
  { path: "/api/v1/responses/input_tokens", load: () => import("@/app/api/v1/responses/input_tokens/route"), body: input },
  { path: "/api/v1/embeddings", load: () => import("@/app/api/v1/embeddings/route"), body: input },
  { path: "/api/v1/moderations", load: () => import("@/app/api/v1/moderations/route"), body: input },
  {
    path: "/api/v1/audio/speech",
    load: () => import("@/app/api/v1/audio/speech/route"),
    body: (text) => ({ model: MODEL, input: text, voice: "alloy" }),
  },
  { path: "/api/v1/images/generations", load: () => import("@/app/api/v1/images/generations/route"), body: prompt },
  { path: "/api/v1/images/edits", load: () => import("@/app/api/v1/images/edits/route"), body: prompt },
  { path: "/api/v1/images/variations", load: () => import("@/app/api/v1/images/variations/route"), body: prompt },
  { path: "/api/v1/videos", load: () => import("@/app/api/v1/videos/route"), body: prompt },
  {
    path: "/api/v1/videos/[id]/remix",
    load: () => import("@/app/api/v1/videos/[id]/remix/route"),
    body: (text) => ({ prompt: text }),
    params: { id: VIDEO_ID },
  },
  {
    path: "/api/v1/rerank",
    load: () => import("@/app/api/v1/rerank/route"),
    body: (text) => ({ model: MODEL, query: text, documents: ["first", "second"] }),
  },
  {
    path: "/api/v1/systemone",
    load: () => import("@/app/api/v1/systemone/route"),
    body: (text) => ({ model: MODEL, state: text, questions: {} }),
  },
  { path: "/api/v1/ocr", load: () => import("@/app/api/v1/ocr/route"), body: (text) => ({ model: MODEL, document: text }) },
  {
    path: "/api/subscription/v1/chat/completions",
    load: () => import("@/app/api/subscription/v1/chat/completions/route"),
    body: chat,
  },
  { path: "/api/subscription/v1/messages", load: () => import("@/app/api/subscription/v1/messages/route"), body: anthropic },
  { path: "/api/subscription/v1/messages/count_tokens", load: () => import("@/app/api/subscription/v1/messages/count_tokens/route"), body: anthropic },
  { path: "/api/subscription/v1/responses", load: () => import("@/app/api/subscription/v1/responses/route"), body: input },
];

export const OTHER_POST_ROUTES = [
  "/api/v1/integrations/mcp",
  "/api/v1/mcp",
  "/api/v1/audio/transcriptions",
  "/api/v1/audio/translations",
  "/api/v1/batches",
  "/api/v1/batches/[id]/cancel",
  "/api/v1/files",
  "/api/v1/vector_stores",
  "/api/v1/vector_stores/[id]",
  "/api/v1/vector_stores/[id]/file_batches",
  "/api/v1/vector_stores/[id]/file_batches/[batch_id]/cancel",
  "/api/v1/vector_stores/[id]/files",
  "/api/v1/vector_stores/[id]/files/[file_id]",
  "/api/v1/vector_stores/[id]/search",
];

export async function callRoute(route: ModelRoute, body: JsonMap): Promise<Response> {
  const { POST } = await route.load();
  const params = route.params ?? {};
  const urlPath = route.path.replace(/\[(\w+)\]/g, (_match, name: string) => params[name] ?? name);
  return POST(gatewayRequest(urlPath, body), { params: Promise.resolve(params) });
}

export async function errorOf(res: Response): Promise<{ status: number; message: string }> {
  const json = (await res.json()) as { error?: { message?: string } };
  return { status: res.status, message: json.error?.message ?? "" };
}

const appRoot = fileURLToPath(new URL("../../../src/app", import.meta.url));

function routeDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeDirs(full);
    return entry.name === "route.ts" ? [dir] : [];
  });
}

export async function gatewayPostRoutes(): Promise<string[]> {
  const dirs = ["api/v1", "api/subscription"].flatMap((surface) => routeDirs(path.join(appRoot, surface)));
  const routes: string[] = [];
  for (const dir of dirs) {
    const mod = (await import(path.join(dir, "route.ts"))) as Record<string, unknown>;
    if (typeof mod.POST === "function") routes.push(`/${path.relative(appRoot, dir).split(path.sep).join("/")}`);
  }
  return routes.sort();
}
