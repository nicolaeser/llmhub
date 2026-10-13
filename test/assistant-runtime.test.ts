import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { AssistantContext, AssistantEvent, AssistantMessage } from "@/types/assistant";
import type { AuthenticatedSession, Permission } from "@/types/auth";

process.env.OPENROUTER_API_KEY = "sk-or-v1-never-used-by-the-assistant";

type Args = {
  where?: Record<string, unknown> & { alias?: string; enabled?: boolean; key?: string; id?: string };
  data?: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
};
type Call = { model: string; method: string; args: Args };
type Handler = (args: Args) => unknown;
type Completion = (body: Record<string, unknown>) => Record<string, unknown>;

const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const calls: Call[] = [];
let handlers: Record<string, Handler> = {};
let enterprise: Record<string, unknown> = {};

function deployment(alias: string) {
  return {
    id: `dep-${alias}`,
    kind: "openai_compat",
    baseUrl: `https://${alias}.upstream.test/v1`,
    model: `${alias}-upstream`,
    weight: 1,
    costInput: 0,
    costOutput: 0,
    providerId: null,
    provider: null,
  };
}

function group(alias: string, enabled = true) {
  return {
    alias,
    enabled,
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    deployments: [deployment(alias)],
  };
}

const groups = new Map([
  ["alpha", group("alpha")],
  ["beta", group("beta")],
  ["gamma", group("gamma", false)],
]);

function fallback(model: string, method: string, args: Args): unknown {
  if (model === "setting" && method === "findUnique") {
    return args.where?.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null;
  }
  if (model === "modelGroup" && method === "findUnique") {
    const found = groups.get(args.where?.alias ?? "");
    return found && (args.where?.enabled !== true || found.enabled) ? found : null;
  }
  if (method === "deleteMany" || method === "updateMany" || method === "createMany") return { count: 0 };
  if (method === "findMany" || method === "groupBy") return [];
  if (method === "count") return 0;
  if (method === "aggregate") return { _sum: {} };
  if (method === "create" || method === "update" || method === "upsert") return { id: `${model}-1`, ...args.data };
  return null;
}

const prisma: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, model) => {
      if (typeof model !== "string" || model === "then") return undefined;
      if (model === "$transaction") {
        return async (input: unknown) =>
          typeof input === "function" ? input(prisma) : Promise.all(input as Promise<unknown>[]);
      }
      return new Proxy(
        {},
        {
          get: (_inner, method) => {
            if (typeof method !== "string" || method === "then") return undefined;
            return async (args: Args = {}) => {
              calls.push({ model, method, args });
              const handler = handlers[`${model}.${method}`];
              return handler ? handler(args) : fallback(model, method, args);
            };
          },
        },
      );
    },
  },
);
(globalThis as { prisma?: unknown }).prisma = prisma;

const upstream: { url: string; body: Record<string, unknown> }[] = [];
let completions: Completion[] = [];
let defaultCompletion: Completion = () => reply("Done.");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  upstream.push({ url: String(input), body });
  const next = completions.shift() ?? defaultCompletion;
  return new Response(JSON.stringify(next(body)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const consoleLines: string[] = [];
mock.method(console, "log", (line: unknown) => consoleLines.push(String(line)));
mock.method(console, "error", (line: unknown) => consoleLines.push(String(line)));

function reply(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
}

function toolCallReply(...toolCalls: { id: string; name: string; args: Record<string, unknown> }[]): Completion {
  return () => ({
    id: "chatcmpl-tools",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
}

function reset(next: Record<string, Handler> = {}) {
  handlers = next;
  calls.length = 0;
  upstream.length = 0;
  completions = [];
  defaultCompletion = () => reply("Done.");
  enterprise = {};
  consoleLines.length = 0;
}

function writes() {
  return calls.filter((call) => WRITE_METHODS.has(call.method));
}

async function allPermissions(): Promise<Permission[]> {
  const { PERMISSIONS } = await import("@/lib/auth/permissions");
  return Object.values(PERMISSIONS);
}

async function context(overrides: Partial<AssistantContext> = {}): Promise<AssistantContext> {
  return {
    userId: "user-1",
    permissions: await allPermissions(),
    disabledTools: [],
    orgId: null,
    locale: "en",
    allowWrite: true,
    ...overrides,
  };
}

function principal(
  permissions: Permission[],
  options: { isOwner?: boolean; role?: AuthenticatedSession["role"] } = {},
): AuthenticatedSession {
  return {
    error: false,
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "ops",
      email: "ops@example.com",
      orgId: null,
      blocked: false,
    } as AuthenticatedSession["user"],
    isOwner: options.isOwner ?? false,
    role: options.role ?? null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

async function asPrincipal<T>(session: AuthenticatedSession, fn: () => Promise<T>): Promise<T> {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  return runAsPrincipal(session, fn);
}

async function runChat(opts: { history: AssistantMessage[]; ctx: AssistantContext; model?: string }) {
  const { runAssistant } = await import("@/lib/assistant/run");
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(opts)) events.push(event);
  return events;
}

function chatRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/internal-api/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "beta", write: true }),
  });
}

function systemPrompt(body: Record<string, unknown>): string {
  const [first] = body.messages as { role: string; content: string }[];
  assert.equal(first?.role, "system");
  return first.content;
}

const hello: AssistantMessage[] = [{ role: "user", content: "hello" }];

test("list_keys reads only public key columns and never returns a hash or secret", async () => {
  const { callMcpTool } = await import("@/lib/assistant/mcp");
  reset({
    "virtualKey.findMany": () => [
      {
        id: "key-1",
        keyAlias: "ops",
        prefix: "sk-hub-ab12",
        spend: 1.5,
        maxBudget: 10,
        blocked: false,
        hash: "stored-hash-value",
        prevHash: "previous-hash-value",
        userId: "user-1",
      },
    ],
  });
  const { result } = await callMcpTool("list_keys", {}, await context());
  const [read] = calls;
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(read?.args.select ?? {}).sort(), ["blocked", "id", "keyAlias", "maxBudget", "prefix", "spend"]);
  assert.equal(read?.args.include, undefined);
  assert.deepEqual(result, [{ id: "key-1", alias: "ops", prefix: "sk-hub-ab12", spend: 1.5, maxBudget: 10, blocked: false }]);
  assert.doesNotMatch(JSON.stringify(result), /stored-hash-value|previous-hash-value/);
});

test("the assistant chat route rejects cross-site posts before it reads the session", async () => {
  const { POST } = await import("@/app/internal-api/assistant/chat/route");
  reset();
  const req = chatRequest({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  const res = await POST(req);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(upstream, []);
});

test("without a console session the chat route never reads the body or opens a stream", async () => {
  const { POST } = await import("@/app/internal-api/assistant/chat/route");
  reset();
  const req = chatRequest({});
  const res = await POST(req).catch(() => null);
  assert.ok(res === null || res.status === 401);
  assert.equal(req.bodyUsed, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(upstream, []);
});

test("the assistant page loader needs assistant:use", async () => {
  const { loadAssistant } = await import("@/lib/assistant/console");
  const { loadAssistantAction } = await import("@/app/(app)/assistant/_action");
  const { AuthError } = await import("@/lib/auth/errors");
  reset();
  const permissions = (await allPermissions()).filter((permission) => permission !== "assistant:use");
  await asPrincipal(principal(permissions), async () => {
    await assert.rejects(loadAssistant(), (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN");
    assert.deepEqual(await loadAssistantAction(), { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" });
  });
  assert.deepEqual(calls, []);
  const allowed = await asPrincipal(principal(["assistant:use"]), () => loadAssistant());
  assert.equal(allowed.canWrite, false);
});

test("the assistant page applies the model lock and the role's tool switches", async () => {
  const { loadAssistant } = await import("@/lib/assistant/console");
  const role = { id: "role-ops", templateKey: null, name: "Ops" } as AuthenticatedSession["role"];
  const operator = principal(await allPermissions(), { role });
  reset({
    "modelGroup.findMany": () => [{ alias: "alpha" }, { alias: "beta" }],
    "role.findUnique": () => ({ assistantToolsDisabled: ["get_usage", "create_key", "rm_rf"] }),
  });
  enterprise = { assistant_model: "beta", assistant_model_locked: true };
  const locked = await asPrincipal(operator, () => loadAssistant());
  assert.deepEqual(locked.models, ["beta"]);
  assert.equal(locked.defaultModel, "beta");
  assert.equal(locked.modelLocked, true);
  const names = locked.tools.map((tool) => tool.name);
  assert.equal(names.includes("get_usage"), false);
  assert.equal(names.includes("create_key"), false);
  assert.equal(names.includes("get_overview"), true);
  assert.deepEqual(calls.find((call) => call.model === "role")?.args.where, { id: "role-ops" });

  enterprise = { assistant_model: "beta", assistant_model_locked: false };
  const open = await asPrincipal(operator, () => loadAssistant());
  assert.deepEqual(open.models, ["alpha", "beta"]);
  assert.equal(open.defaultModel, "beta");
  assert.equal(open.modelLocked, false);

  calls.length = 0;
  const owner = await asPrincipal(principal(await allPermissions(), { isOwner: true, role }), () => loadAssistant());
  assert.equal(owner.tools.some((tool) => tool.name === "create_key"), true);
  assert.equal(calls.some((call) => call.model === "role"), false);
});

test("the run sends the posted alias through the gateway instead of the first model group", async () => {
  reset();
  await runChat({ history: hello, ctx: await context(), model: "beta" });
  assert.deepEqual(
    upstream.map((call) => [call.url, call.body.model]),
    [["https://beta.upstream.test/v1/chat/completions", "beta-upstream"]],
  );

  reset();
  enterprise = { assistant_model: "beta" };
  await runChat({ history: hello, ctx: await context(), model: "" });
  assert.deepEqual(upstream.map((call) => call.body.model), ["beta-upstream"]);

  reset();
  enterprise = { assistant_model: "alpha", assistant_model_locked: true };
  await runChat({ history: hello, ctx: await context(), model: "beta" });
  assert.deepEqual(upstream.map((call) => call.body.model), ["alpha-upstream"]);

  for (const model of ["", "gamma", "missing"]) {
    reset();
    await assert.rejects(runChat({ history: hello, ctx: await context(), model }), /getTranslations/, model);
    assert.deepEqual(upstream, [], model);
    assert.equal(
      calls.some((call) => call.model === "modelGroup" && (call.method === "findFirst" || call.method === "findMany")),
      false,
      model,
    );
  }
});

test("the run is metered by the gateway and never calls a provider on its own", async () => {
  reset();
  const ctx = await context();
  const events = await runChat({ history: hello, ctx, model: "beta" });
  assert.deepEqual(events, [{ type: "text", delta: "Done." }, { type: "done" }]);
  assert.ok(upstream.every((call) => call.url.startsWith("https://beta.upstream.test/")));
  assert.equal(upstream.some((call) => /openrouter/i.test(call.url)), false);
  const logged = calls.find((call) => call.model === "requestLog" && call.method === "create");
  assert.equal(logged?.args.data?.endpoint, "/internal-api/assistant/chat");
  assert.equal(logged?.args.data?.userId, ctx.userId);
  assert.ok(calls.some((call) => call.model === "spendEvent" && call.method === "create"));
  for (const line of consoleLines) {
    assert.equal(typeof JSON.parse(line).event, "string", line);
    assert.doesNotMatch(line, /hello/);
  }
});

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    prefix: "sk-hub-ab12",
    keyAlias: "ops",
    hash: "stored-hash-value",
    userId: "user-1",
    teamId: "team-1",
    orgId: "org-1",
    projectId: null,
    memberId: "member-1",
    models: [],
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
    piiPolicy: null,
    logContent: true,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    templates: [],
    ...overrides,
  };
}

test("the run streams tool calls and results by id and hands a new secret only to the operator", async () => {
  const { digest } = await import("@/lib/crypto");
  reset({
    "virtualKey.create": ({ data }) =>
      keyRow({ id: "key-new", prefix: data?.prefix, keyAlias: data?.keyAlias, memberId: null, teamId: null, orgId: null }),
  });
  completions = [toolCallReply({ id: "call_create", name: "create_key", args: { alias: "ci" } })];
  const ctx = await context();
  const events = await asPrincipal(principal(ctx.permissions), () => runChat({ history: hello, ctx, model: "beta" }));

  const secretEvent = events.find((event) => event.type === "secret");
  assert.ok(secretEvent?.type === "secret");
  const secret = secretEvent.value;
  assert.match(secret, /^sk-hub-/);
  assert.equal(writes().find((call) => call.model === "virtualKey")?.args.data?.hash, digest(secret));
  assert.deepEqual(
    events.map((event) => (event.type === "text" ? `text:${event.delta}` : `${event.type}:${"id" in event ? event.id : ""}`)),
    ["tool_call:0-0", "tool_result:0-0", "secret:0-0", "text:Done.", "done:"],
  );
  assert.deepEqual(events.find((event) => event.type === "tool_call"), {
    type: "tool_call",
    id: "0-0",
    name: "create_key",
    args: { alias: "ci" },
  });
  const result = events.find((event) => event.type === "tool_result");
  assert.ok(result?.type === "tool_result");
  assert.equal(result.name, "create_key");
  assert.equal(result.status, "done");
  assert.equal(result.href, "/keys");
  assert.equal(JSON.stringify(events.filter((event) => event.type !== "secret")).includes(secret), false);

  assert.equal(upstream.length, 2);
  const toolMessage = (upstream[1]?.body.messages as { role: string; tool_call_id?: string; content: string }[]).find(
    (message) => message.role === "tool",
  );
  assert.equal(toolMessage?.tool_call_id, "call_create");
  assert.equal(JSON.parse(toolMessage?.content ?? "{}").alias, "ci");
  assert.equal(JSON.stringify(upstream).includes(secret), false);
});

test("the run tells the model whether this request may write", async () => {
  const toolNames = (body: Record<string, unknown>) =>
    (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
  reset();
  await runChat({ history: hello, ctx: await context({ allowWrite: true }), model: "beta" });
  assert.match(systemPrompt(upstream[0]!.body), /Write access is on/);
  assert.equal(toolNames(upstream[0]!.body).includes("create_key"), true);

  reset();
  await runChat({ history: hello, ctx: await context({ allowWrite: false }), model: "beta" });
  assert.match(systemPrompt(upstream[0]!.body), /Read-only mode/);
  assert.equal(toolNames(upstream[0]!.body).includes("create_key"), false);
  assert.equal(toolNames(upstream[0]!.body).includes("list_keys"), true);
});

test("the run stops calling tools at the step limit and asks for a summary without tools", async () => {
  const { ASSISTANT_STEP_LIMIT_NOTE } = await import("@/lib/assistant/prompt");
  reset();
  defaultCompletion = (body) =>
    body.tool_choice === "none"
      ? reply("Here is what I found.")
      : toolCallReply({ id: `call_${upstream.length}`, name: "explain", args: { topic: "keys" } })(body);
  const events = await runChat({ history: hello, ctx: await context(), model: "beta" });
  assert.deepEqual(
    upstream.map((call) => call.body.tool_choice),
    [...Array(10).fill("auto"), "none"],
  );
  assert.match(ASSISTANT_STEP_LIMIT_NOTE, /Do not call tools/);
  assert.ok(systemPrompt(upstream[10]!.body).endsWith(ASSISTANT_STEP_LIMIT_NOTE));
  assert.equal(systemPrompt(upstream[9]!.body).includes(ASSISTANT_STEP_LIMIT_NOTE), false);
  assert.deepEqual(
    events.filter((event) => event.type === "tool_call").map((event) => ("id" in event ? event.id : "")),
    Array.from({ length: 10 }, (_, step) => `${step}-0`),
  );
  assert.deepEqual(events.slice(-2), [{ type: "text", delta: "Here is what I found." }, { type: "done" }]);
});

test("replayed history pairs tool results with their calls and reaches the model without secrets", async () => {
  const { parseClientMessages } = await import("@/lib/assistant/parse");
  const secret = `sk-hub-${"ab".repeat(18)}`;
  const providerKey = "sk-proj-abcdefghijklmnopqrstuvwx";
  const history = parseClientMessages([
    { role: "user", content: `my key is ${secret}` },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Checking." },
        { type: "tool", name: "update_key", args: { key: secret, alias: "ops" }, result: { ok: true } },
        { type: "tool", name: "list_keys", args: {}, result: [{ alias: "ops" }] },
        { type: "text", text: "Renamed." },
      ],
    },
    { role: "user", content: `and this one ${providerKey}` },
  ]);
  reset();
  await runChat({ history, ctx: await context(), model: "beta" });
  const sent = upstream[0]!.body.messages as {
    role: string;
    tool_call_id?: string;
    tool_calls?: { id: string; function: { name: string } }[];
  }[];
  assert.deepEqual(
    sent.map((message) => message.role),
    ["system", "user", "assistant", "tool", "tool", "assistant", "user"],
  );
  assert.deepEqual(
    sent[2]?.tool_calls?.map((call) => call.id),
    [sent[3]?.tool_call_id, sent[4]?.tool_call_id],
  );
  assert.deepEqual(
    sent[2]?.tool_calls?.map((call) => call.function.name),
    ["update_key", "list_keys"],
  );
  const wire = JSON.stringify(upstream[0]!.body);
  assert.equal(wire.includes(secret), false);
  assert.equal(wire.includes(providerKey), false);
});

test("search_logs reads request metadata only and scopes rows to the operator without spend:read-all", async () => {
  const { callMcpTool } = await import("@/lib/assistant/mcp");
  const logRow = {
    id: "log-1",
    createdAt: new Date("2026-10-06T10:00:00.000Z"),
    model: "beta",
    endpoint: "/api/v1/chat/completions",
    status: 502,
    outcome: "upstream_error",
    latencyMs: 40,
    keyId: "key-1",
    userId: "user-2",
    provider: "openai",
    upstreamModel: "gpt-x",
    promptTokens: 1,
    completionTokens: 2,
    cost: 0.5,
    error: "upstream 502",
    tag: "customer-acme",
    content: { request: "PROMPT-TEXT", response: "RESPONSE-TEXT" },
  };
  const lookups: Record<string, Handler> = {
    "requestLog.findMany": () => [logRow],
    "requestLog.count": () => 1,
    "user.findMany": () => [{ id: "user-2", username: "analyst" }],
  };

  reset(lookups);
  const own = await callMcpTool("search_logs", {}, await context({ permissions: ["spend:read"] }));
  const read = calls.find((call) => call.model === "requestLog" && call.method === "findMany");
  assert.ok(read?.args.select);
  assert.equal(read.args.include, undefined);
  for (const field of ["content", "tag"]) assert.equal(field in read.args.select, false, field);
  assert.equal(read.args.where?.userId, "user-1");
  assert.equal(calls.some((call) => call.model === "requestLogContent"), false);
  assert.doesNotMatch(JSON.stringify(own), /PROMPT-TEXT|RESPONSE-TEXT|customer-acme/);
  const ownRows = (own.result as { requests: Record<string, unknown>[] }).requests;
  assert.equal(ownRows[0]?.id, "log-1");
  assert.equal("user" in (ownRows[0] ?? {}), false);

  reset(lookups);
  const all = await callMcpTool("search_logs", {}, await context({ permissions: ["spend:read", "spend:read-all"] }));
  const readAll = calls.find((call) => call.model === "requestLog" && call.method === "findMany");
  assert.equal(readAll?.args.where?.userId, undefined);
  assert.equal((all.result as { requests: { user?: string }[] }).requests[0]?.user, "analyst");
  assert.doesNotMatch(JSON.stringify(all), /PROMPT-TEXT|RESPONSE-TEXT|customer-acme/);
});

const writeToolCalls: Record<string, Record<string, unknown>[]> = {
  create_provider: [{ kind: "openai", name: "Main" }],
  update_provider: [{ id: "provider-1", name: "Renamed" }],
  refresh_provider_models: [{ id: "provider-1" }],
  import_provider_models: [{ id: "provider-1" }],
  delete_provider: [{ id: "provider-1", confirm: true }],
  create_model: [{ alias: "delta", providerId: "provider-1", upstreamModel: "gpt-x" }],
  update_model: [{ alias: "beta", enabled: false }],
  delete_model: [{ alias: "beta", confirm: true }],
  save_model_template: [{ name: "EU only", regions: ["eu"] }],
  delete_model_template: [{ id: "template-1", confirm: true }],
  create_key: [{ alias: "ci" }],
  update_key: [{ key: "key-1", alias: "renamed" }],
  rotate_key: [{ key: "key-1", confirm: true }],
  revoke_key: [{ key: "key-1", confirm: true }],
  save_structure_node: [
    { kind: "org", alias: "Acme" },
    { kind: "team", alias: "Research", orgId: "org-1" },
    { kind: "project", alias: "Search", orgId: "org-1" },
    { kind: "member", alias: "Ada", orgId: "org-1", email: "ada@example.com" },
  ],
  delete_structure_node: [{ kind: "team", id: "team-1", confirm: true }],
  set_budget: [{ kind: "org", id: "org-1", maxBudget: 10 }],
  add_budget_boost: [{ kind: "org", id: "org-1", amount: 5, hours: 1 }],
  remove_budget_boost: [{ boostId: "boost-1" }],
  set_budget_alerts: [{ thresholds: [50, 90] }],
  set_user_blocked: [{ userId: "user-2", blocked: true, confirm: true }],
  assign_user_role: [{ userId: "user-2", roleId: "role-ops" }],
  revoke_user_sessions: [{ userId: "user-2", confirm: true }],
  update_guardrails: [{ enabled: false }],
  update_gateway_settings: [{ cacheTtlSeconds: 60 }, { logRetentionDays: 7 }],
};

const existingRows: Record<string, Handler> = {
  "virtualKey.findMany": () => [keyRow()],
  "virtualKey.findUnique": () => keyRow(),
  "providerConnection.findUnique": () => ({ id: "provider-1", zdr: false, retentionDays: null, region: "", noTraining: false }),
  "providerConnection.findMany": () => [{ id: "provider-1", name: "OpenAI", kind: "openai", baseUrl: "" }],
  "user.findUnique": () => ({ id: "user-2", revision: 1, orgId: null }),
};

test("every write tool goes through a console service that re-checks the operator's manage permission", async () => {
  const { callMcpTool } = await import("@/lib/assistant/mcp");
  const { assistantToolCatalog, assistantToolNames } = await import("@/lib/assistant/catalog");
  const writeTools = assistantToolNames.filter((name) => assistantToolCatalog[name].access !== "read");
  assert.deepEqual(Object.keys(writeToolCalls).sort(), [...writeTools].sort());
  const everything = await allPermissions();
  const ctx = await context();
  for (const name of writeTools) {
    const permission = assistantToolCatalog[name].permission;
    const operator = principal(everything.filter((granted) => granted !== permission));
    for (const args of writeToolCalls[name] ?? []) {
      const label = `${name} ${JSON.stringify(args)}`;
      reset(existingRows);
      const called = await asPrincipal(operator, () => callMcpTool(name, args, ctx));
      assert.deepEqual(called, { result: { error: "forbidden" } }, label);
      assert.deepEqual(writes(), [], label);
      assert.deepEqual(upstream, [], label);

      reset(existingRows);
      const permitted = await asPrincipal(principal(everything), () => callMcpTool(name, args, ctx));
      assert.notDeepEqual(permitted, { result: { error: "forbidden" } }, label);
    }
  }
});

test("create_provider never stores an API key from the conversation", async () => {
  const { callMcpTool } = await import("@/lib/assistant/mcp");
  reset({
    "providerConnection.create": ({ data }) => ({
      id: "provider-new",
      enabled: true,
      restricted: false,
      assignments: [],
      login: null,
      discovered: [],
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      ...data,
    }),
  });
  const called = await asPrincipal(principal(["providers:manage"]), async () =>
    callMcpTool("create_provider", { kind: "openai", name: "Main", apiKey: "sk-live-pasted-key" }, await context()),
  );
  assert.equal(called.navigate, "/providers");
  assert.equal((called.result as { ok?: boolean; id?: string }).ok, true);
  const created = writes().find((call) => call.model === "providerConnection" && call.method === "create");
  assert.equal(created?.args.data?.apiKey, "");
  assert.equal(JSON.stringify(calls).includes("sk-live-pasted-key"), false);
});

test("update_key keeps the key's binding unless the call sends projectId or memberId", async () => {
  const { callMcpTool } = await import("@/lib/assistant/mcp");
  const rows: Record<string, Handler> = {
    ...existingRows,
    "member.findUnique": () => ({ id: "member-1", orgId: "org-1", teamId: "team-1" }),
    "project.findUnique": () => ({ id: "project-1", orgId: "org-1", teamId: null }),
    "virtualKey.update": ({ data }) => keyRow({ ...data, templates: [] }),
  };
  const operator = principal(["keys:read", "keys:read-all", "keys:manage", "tenancy:manage"]);
  const update = async (args: Record<string, unknown>) => {
    reset(rows);
    const called = await asPrincipal(operator, async () => callMcpTool("update_key", { key: "key-1", ...args }, await context()));
    assert.equal((called.result as { ok?: boolean }).ok, true, JSON.stringify(called));
    const data = writes().find((call) => call.model === "virtualKey" && call.method === "update")?.args.data ?? {};
    return { keyAlias: data.keyAlias, projectId: data.projectId, memberId: data.memberId };
  };
  assert.deepEqual(await update({ alias: "renamed" }), { keyAlias: "renamed", projectId: null, memberId: "member-1" });
  assert.deepEqual(await update({ projectId: "project-1" }), { keyAlias: "ops", projectId: "project-1", memberId: null });
  assert.deepEqual(await update({ projectId: "", memberId: "" }), { keyAlias: "ops", projectId: null, memberId: null });
});
