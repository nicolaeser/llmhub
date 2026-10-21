import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap } from "@/types/gateway";
import type { ResolvedDeployment } from "@/types/routing";
import type { DeviceGrant, LimitWindow, SignInSession } from "@/types/providers";

type FakeLogin = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  leaseUntil: Date | null;
  refreshedAt: Date | null;
  retryAt: Date | null;
  failures: number;
};

const logins = new Map<string, FakeLogin>();

(globalThis as { prisma?: unknown }).prisma = {
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { providerId: string; version: number };
      data: Partial<FakeLogin> & { version?: { increment: number } };
    }) => {
      const row = logins.get(where.providerId);
      if (!row || row.version !== where.version) return { count: 0 };
      if (row.leaseUntil && row.leaseUntil.getTime() >= Date.now() && data.leaseUntil) return { count: 0 };
      const { version, ...rest } = data;
      Object.assign(row, rest);
      if (version) row.version += version.increment;
      return { count: 1 };
    },
  },
};

const realFetch = globalThis.fetch;
let calls: { url: string; body: string; headers: Record<string, string> }[] = [];

function respondWith(handler: (url: string, body: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, body);
  }) as typeof fetch;
}

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function sse(events: JsonMap[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function dep(kind: string, model: string): ResolvedDeployment {
  return {
    id: `d-${kind}`,
    kind,
    base_url: "https://evil.example/v1",
    model,
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: "p1",
  };
}

async function seedLogin(providerId: string, tokens: SignInSession["tokens"], expiresAt: number, plan = "") {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  logins.set(providerId, {
    providerId,
    account: "dev@example.com",
    plan,
    tokens: sealTokens(tokens),
    expiresAt: new Date(expiresAt),
    status: "active",
    version: 0,
    leaseUntil: null,
    refreshedAt: null,
    retryAt: null,
    failures: 0,
  });
}

beforeEach(() => {
  calls = [];
  logins.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Kimi Code and Muse Code are subscription kinds and the API kinds stay in the API pool", async () => {
  const kinds = await import("@/lib/gateway/upstreams/provider-kinds");
  const { routePool } = await import("@/lib/gateway/routing/route-pool");
  for (const kind of ["kimi", "kimi_ai", "muse_code"]) {
    assert.equal(kinds.isSignInKind(kind), true);
    assert.equal(kinds.reportsLimits(kind), true);
    assert.equal(kinds.signInMethod(kind as "kimi"), "device");
    assert.equal(routePool({ kind, provider: { kind, internal: false } }), "subscription");
  }
  for (const kind of ["moonshot", "moonshot_cn", "meta"]) {
    assert.equal(kinds.isSignInKind(kind), false);
    assert.equal(routePool({ kind, provider: { kind, internal: false } }), "api");
  }
  assert.equal(kinds.servesMessages("kimi_ai"), true);
  assert.equal(kinds.servesMessages("moonshot"), false);
  assert.equal(kinds.limitsFromTraffic("muse_code"), true);
  assert.equal(kinds.limitsFromTraffic("kimi"), false);
});

test("Kimi device sign-in uses the chosen domain and keeps one device id through polling", async () => {
  const { pollDeviceCode, startAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  respondWith((url) =>
    url.endsWith("/device_authorization")
      ? Response.json({
          device_code: "dc1",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        })
      : Response.json({ error: "authorization_pending" }),
  );
  const started = await startAuthorization("kimi_ai");
  assert.equal(calls[0]!.url, "https://auth.kimi.ai/api/oauth/device_authorization");
  assert.equal(new URLSearchParams(calls[0]!.body).get("client_id"), "17e5f671-d194-4dfb-9706-5516cb48c098");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(started.expiresIn, 600);
  const grant = started.grant as Extract<DeviceGrant, { kind: "kimi_ai" }>;
  assert.equal(grant.kind, "kimi_ai");
  assert.equal(calls[0]!.headers["X-Msh-Device-Id"], grant.device);
  assert.equal(calls[0]!.headers["X-Msh-Platform"], "llmhub");

  assert.deepEqual(await pollDeviceCode(grant), { state: "pending", slowDown: false });
  assert.equal(calls[1]!.url, "https://auth.kimi.ai/api/oauth/token");
  assert.equal(new URLSearchParams(calls[1]!.body).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(calls[1]!.headers["X-Msh-Device-Id"], grant.device);

  respondWith(() => Response.json({ error: "slow_down" }));
  assert.deepEqual(await pollDeviceCode(grant), { state: "pending", slowDown: true });
  respondWith(() => Response.json({ error: "access_denied" }, { status: 400 }));
  assert.deepEqual(await pollDeviceCode(grant), { state: "denied" });
  respondWith(() => Response.json({ error: "expired_token" }, { status: 400 }));
  assert.deepEqual(await pollDeviceCode(grant), { state: "expired" });

  const access = jwt({ exp: Math.floor(Date.now() / 1000) + 900, user_id: "u-42", email: "kimi@example.com" });
  respondWith(() => Response.json({ access_token: access, refresh_token: "kr1", token_type: "Bearer", expires_in: 900 }));
  const done = await pollDeviceCode(grant);
  assert.equal(done.state, "done");
  if (done.state !== "done") return;
  assert.equal(done.session.tokens.refresh, "kr1");
  assert.equal(done.session.tokens.accountId, "u-42");
  assert.equal(done.session.tokens.device, grant.device);
  assert.equal(done.session.account, "kimi@example.com");

  respondWith(() => Response.json({ device_code: "d", user_code: "u", verification_uri: "https://www.kimi.com/code" }));
  await startAuthorization("kimi");
  assert.equal(calls.at(-1)!.url, "https://auth.kimi.com/api/oauth/device_authorization");
});

test("Kimi refresh sends the stored device id and treats a rejected refresh token as fatal", async () => {
  const { refreshSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const current: SignInSession = {
    tokens: { access: "old", refresh: "kr1", accountId: "u-42", residency: "", device: "dev-1" },
    expiresAt: Date.now() + 60_000,
    account: "kimi@example.com",
    plan: "",
  };
  respondWith(() => Response.json({ access_token: "new", refresh_token: "kr2", expires_in: 900 }));
  const refreshed = await refreshSession("kimi", current);
  assert.equal(calls[0]!.url, "https://auth.kimi.com/api/oauth/token");
  const form = new URLSearchParams(calls[0]!.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "kr1");
  assert.equal(calls[0]!.headers["X-Msh-Device-Id"], "dev-1");
  assert.ok(refreshed.ok);
  if (!refreshed.ok) return;
  assert.equal(refreshed.session.tokens.access, "new");
  assert.equal(refreshed.session.tokens.refresh, "kr2");
  assert.equal(refreshed.session.tokens.device, "dev-1");
  assert.equal(refreshed.session.account, "kimi@example.com");

  respondWith(() => Response.json({ error_description: "nope" }, { status: 403 }));
  assert.deepEqual(await refreshSession("kimi_ai", current), { ok: false, fatal: true, retryAfterMs: null });
  assert.equal(calls.at(-1)!.url, "https://auth.kimi.ai/api/oauth/token");
  respondWith(() => new Response("", { status: 502 }));
  assert.deepEqual(await refreshSession("kimi", current), { ok: false, fatal: false, retryAfterMs: null });
});

test("Muse device sign-in mints an API key from the device-client token", async () => {
  const { pollDeviceCode, startAuthorization } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  respondWith(() =>
    Response.json({
      device_code: "mdc",
      user_code: "WXYZ",
      verification_uri: "https://auth.meta.com/device",
      verification_uri_complete: "https://auth.meta.com/device?user_code=WXYZ",
      expires_in: 900,
      interval: 5,
    }),
  );
  const started = await startAuthorization("muse_code");
  assert.equal(calls[0]!.url, "https://auth.meta.com/oidc/device/authorization/");
  assert.equal(new URLSearchParams(calls[0]!.body).get("client_id"), "1031625952748946");
  assert.equal(calls[0]!.headers["User-Agent"], "muse-code/1.0.2");
  assert.equal(started.verificationUrl, "https://auth.meta.com/device?user_code=WXYZ");

  respondWith(() => Response.json({ error: "authorization_pending" }, { status: 400 }));
  assert.deepEqual(await pollDeviceCode(started.grant), { state: "pending", slowDown: false });

  respondWith((url) =>
    url.endsWith("/oidc/device/token/")
      ? Response.json({ access_token: "dca:abc", token_type: "Bearer", expires_in: 86_400 })
      : Response.json({
          api_key: "LLM|minted",
          base_url: "https://api.meta.ai/v1",
          user_email: "muse@example.com",
          subs_tier_name: "Muse Pro",
          is_subs_active: true,
        }),
  );
  const done = await pollDeviceCode(started.grant);
  assert.equal(done.state, "done");
  if (done.state !== "done") return;
  const mint = calls.at(-1)!;
  assert.equal(mint.url, "https://api.meta.ai/muse-code/key");
  assert.equal(mint.headers.Authorization, "Bearer dca:abc");
  assert.deepEqual(JSON.parse(mint.body), { dca_token: "dca:abc" });
  assert.equal(done.session.tokens.access, "LLM|minted");
  assert.equal(done.session.tokens.refresh, "dca:abc");
  assert.equal(done.session.account, "muse@example.com");
  assert.equal(done.session.plan, "Muse Pro");
  assert.ok(done.session.expiresAt > Date.UTC(9000, 0, 1));

  respondWith((url) =>
    url.endsWith("/oidc/device/token/") ? Response.json({ access_token: "dca:abc" }) : new Response("", { status: 403 }),
  );
  await assert.rejects(pollDeviceCode(started.grant), { message: "SIGN_IN_FAILED" });
});

test("a rejected Muse key is renewed by minting again with the stored device-client token", async () => {
  const { refreshSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const current: SignInSession = {
    tokens: { access: "LLM|old", refresh: "dca:abc", accountId: "", residency: "" },
    expiresAt: Date.UTC(9999, 0, 1),
    account: "muse@example.com",
    plan: "Muse Pro",
  };
  respondWith(() => Response.json({ api_key: "LLM|new" }));
  const refreshed = await refreshSession("muse_code", current);
  assert.equal(calls[0]!.url, "https://api.meta.ai/muse-code/key");
  assert.ok(refreshed.ok);
  if (!refreshed.ok) return;
  assert.equal(refreshed.session.tokens.access, "LLM|new");
  assert.equal(refreshed.session.tokens.refresh, "dca:abc");
  assert.equal(refreshed.session.plan, "Muse Pro");
  respondWith(() => new Response("", { status: 401 }));
  assert.deepEqual(await refreshSession("muse_code", current), { ok: false, fatal: true, retryAfterMs: null });
});

test("sign-in headers carry the Kimi device and the Muse client identity", async () => {
  const { signInHeaders } = await import("@/lib/gateway/upstreams/credentials");
  const kimi = signInHeaders("kimi", { access: "a", refresh: "r", accountId: "", residency: "", device: "dev-9" });
  assert.equal(kimi["X-Msh-Device-Id"], "dev-9");
  assert.match(kimi["User-Agent"]!, /^LLMHub\//);
  const muse = signInHeaders("muse_code", { access: "a", refresh: "r", accountId: "", residency: "" });
  assert.match(muse["User-Agent"]!, /^muse-build\//);
  assert.equal(muse["X-Client-Id"], "tbh:tui");
});

test("sealed tokens keep the Kimi device id", async () => {
  const { openTokens, sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  const sealed = sealTokens({ access: "a", refresh: "r", accountId: "u", residency: "", device: "dev-1" });
  assert.equal(openTokens(sealed, "p").device, "dev-1");
  assert.equal("device" in openTokens(sealTokens({ access: "a", refresh: "r", accountId: "", residency: "" }), "p"), false);
});

test("CLIProxyAPI Kimi auth files pick the domain and keep the device id", async () => {
  const { authFileKind, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const file = {
    type: "kimi",
    access_token: "kimi-access",
    refresh_token: "kimi-refresh",
    token_type: "Bearer",
    device_id: "dev-file",
    expired: "2026-10-21T10:00:00Z",
    domain: "kimi.ai",
    base_url: "https://api.kimi.ai/coding",
  };
  assert.equal(authFileKind(file), "kimi_ai");
  assert.equal(authFileKind({ type: "kimi-ai" }), "kimi_ai");
  assert.equal(authFileKind({ type: "kimi", base_url: "https://api.kimi.com/coding" }), "kimi");
  assert.equal(authFileKind({ type: "kimi" }), "kimi");
  const parsed = parseAuthFileEntry(file);
  assert.equal(parsed.kind, "kimi_ai");
  assert.equal(parsed.session.tokens.device, "dev-file");
  assert.equal(parsed.session.tokens.refresh, "kimi-refresh");
  assert.equal(parsed.session.expiresAt, Date.parse("2026-10-21T10:00:00Z"));
  const generated = parseAuthFileEntry({ ...file, device_id: undefined, domain: "kimi.com" });
  assert.equal(generated.kind, "kimi");
  assert.match(generated.session.tokens.device ?? "", /^[0-9a-f-]{36}$/);
});

test("CLIProxyAPI Meta auth files import the minted key and its device-client token", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const minted = parseAuthFileEntry({
    type: "meta",
    auth_kind: "oauth",
    access_token: "LLM|key",
    api_key: "LLM|key",
    dca_token: "dca:abc",
    email: "muse@example.com",
    subs_tier_name: "Muse Pro",
    base_url: "https://api.meta.ai/v1",
  });
  assert.equal(minted.kind, "muse_code");
  assert.equal(minted.session.tokens.access, "LLM|key");
  assert.equal(minted.session.tokens.refresh, "dca:abc");
  assert.equal(minted.session.account, "muse@example.com");
  assert.equal(minted.session.plan, "Muse Pro");
  assert.ok(minted.session.expiresAt > Date.UTC(9000, 0, 1));
  const unminted = parseAuthFileEntry({ type: "meta", access_token: "dca:only" });
  assert.equal(unminted.session.tokens.refresh, "dca:only");
  assert.equal(unminted.session.expiresAt, 0);
  assert.throws(() => parseAuthFileEntry({ type: "meta", api_key: "LLM|key" }), { message: "AUTH_FILE_INCOMPLETE" });
});

test("importing a Meta file without a key mints one before checking it", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  respondWith((url) =>
    url.endsWith("/muse-code/key") ? Response.json({ api_key: "LLM|fresh", user_email: "muse@example.com" }) : Response.json({ data: [] }),
  );
  const session = await freshAuthFileSession(parseAuthFileEntry({ type: "meta", access_token: "dca:only" }));
  assert.equal(session.tokens.access, "LLM|fresh");
  assert.equal(session.account, "muse@example.com");
  assert.equal(calls[0]!.url, "https://api.meta.ai/muse-code/key");
  assert.equal(calls[1]!.url, "https://api.meta.ai/v1/models");
  assert.equal(calls[1]!.headers.Authorization, "Bearer LLM|fresh");
});

test("Kimi Code chat bodies map effort to the thinking object and fix temperature, tools, and history", async () => {
  const { kimiChatBody } = await import("@/lib/gateway/upstreams/kimi");
  const body = kimiChatBody(
    {
      model: "kimi-k2.6",
      reasoning_effort: "xhigh",
      temperature: 0.2,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              properties: { item: { $ref: "#/$defs/Item" } },
              $defs: { Item: { type: "object", properties: { id: { type: "string" } } } },
            },
          },
        },
      ],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "thinking out loud", reasoning_content: "plan it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", content: "found" },
      ],
    },
    "kimi",
  );
  assert.deepEqual(body.thinking, { type: "enabled", effort: "high" });
  assert.equal("reasoning_effort" in body, false);
  assert.equal("temperature" in body, false);
  const parameters = ((body.tools as JsonMap[])[0]!.function as JsonMap).parameters as JsonMap;
  assert.equal(parameters.type, "object");
  assert.equal("$defs" in parameters, false);
  assert.deepEqual((parameters.properties as JsonMap).item, { type: "object", properties: { id: { type: "string" } } });
  const messages = body.messages as JsonMap[];
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.reasoning_content, "plan it");
  assert.equal(messages[3]!.tool_call_id, "call_1");

  assert.deepEqual(kimiChatBody({ model: "kimi-k3", reasoning_effort: "max" }, "kimi_ai").thinking, { type: "enabled", effort: "max" });
  const off = kimiChatBody({ model: "kimi-k2.6", reasoning_effort: "none", temperature: 0.6 }, "kimi");
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.temperature, 0.6);
  const fallback = kimiChatBody(
    { model: "kimi-for-coding", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function" }] }] },
    "kimi",
  );
  assert.equal((fallback.messages as JsonMap[])[0]!.reasoning_content, "[reasoning unavailable]");
});

test("Kimi API Platform bodies keep reasoning_effort and leave other vendors' temperature alone", async () => {
  const { kimiChatBody } = await import("@/lib/gateway/upstreams/kimi");
  const platform = kimiChatBody({ model: "kimi-k3", reasoning_effort: "medium", temperature: 0.3 }, "moonshot");
  assert.equal(platform.reasoning_effort, "high");
  assert.equal("thinking" in platform, false);
  assert.equal("temperature" in platform, false);
  const other = kimiChatBody({ model: "moonshot-v1-8k", temperature: 0.3 }, "moonshot_cn");
  assert.equal(other.temperature, 0.3);
});

test("Kimi and Meta deployments use their own paths and bodies", async () => {
  const { joinPath, prepareBody } = await import("@/lib/gateway/dispatch/upstream");
  const kimi = dep("kimi", "kimi-for-coding");
  assert.equal(joinPath(kimi, "/chat/completions"), "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(joinPath(kimi, "/v1/messages"), "https://api.kimi.com/coding/v1/messages");
  assert.equal(joinPath(dep("kimi_ai", "k"), "/chat/completions"), "https://api.kimi.ai/coding/v1/chat/completions");
  const platform = { ...dep("moonshot_cn", "kimi-k3"), base_url: "" };
  assert.equal(joinPath(platform, "/chat/completions"), "https://api.moonshot.cn/v1/chat/completions");
  const kimiBody = prepareBody(kimi, "/chat/completions", { model: "alias", reasoning_effort: "low", service_tier: "priority" });
  assert.equal(kimiBody.model, "kimi-for-coding");
  assert.deepEqual(kimiBody.thinking, { type: "enabled", effort: "low" });
  assert.equal("service_tier" in kimiBody, false);

  const muse = dep("muse_code", "muse-spark-1.3");
  assert.equal(joinPath(muse, "/chat/completions"), "https://api.meta.ai/v1/responses");
  const meta = { ...dep("meta", "muse-spark-1.3"), base_url: "" };
  assert.equal(joinPath(meta, "/chat/completions"), "https://api.meta.ai/v1/responses");
  const museBody = prepareBody(muse, "/chat/completions", {
    model: "alias",
    service_tier: "priority",
    reasoning_effort: "high",
    web_search: { allowed_domains: ["example.com"] },
    messages: [
      { role: "system", content: "be brief" },
      {
        role: "assistant",
        content: "ok",
        thinking_blocks: [
          { type: "thinking", thinking: "x", signature: "Q-PaDgmuse" },
          { type: "thinking", thinking: "y", signature: "gAAAAcodex" },
        ],
      },
      { role: "user", content: "next" },
    ],
  });
  assert.equal(museBody.model, "muse-spark-1.3");
  assert.equal(museBody.instructions, "be brief");
  assert.equal(museBody.stream, true);
  assert.equal("service_tier" in museBody, false);
  assert.deepEqual(museBody.reasoning, { effort: "high", summary: "auto" });
  const reasoning = (museBody.input as JsonMap[]).filter((item) => item.type === "reasoning");
  assert.deepEqual(reasoning.map((item) => item.encrypted_content), ["Q-PaDgmuse"]);
  assert.ok((museBody.tools as JsonMap[]).some((tool) => tool.type === "web_search"));
});

test("Muse streams translate to chat chunks, report plan usage, and hide the usage events", async () => {
  const { museTranslator } = await import("@/lib/gateway/upstreams/muse");
  const usage = {
    type: "response.subscription_usage",
    subscription: {
      tier: "1234567890123456",
      weekly: { resets_at: 1_792_368_000, used_percent: 80 },
      window: { resets_at: 1_792_272_519, used_percent: 10, window_duration_mins: 300 },
    },
  };
  const text =
    sse([usage]) +
    sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "lookup" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"q":1}' },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "reasoning", encrypted_content: "Q-PaDgsig", summary: [{ type: "summary_text", text: "why" }] },
      },
    ]) +
    sse([usage]) +
    sse([{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }]);
  const observed: LimitWindow[][] = [];
  const translator = museTranslator("muse", (windows) => observed.push(windows));
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...translator.pushLine(line));
  const flushed = translator.flush();
  if (flushed) out.push(flushed);
  const chunks = out.map((payload) => JSON.parse(payload) as JsonMap);
  assert.equal(out.some((payload) => payload.includes("1234567890123456")), false);
  const deltas = chunks.map((chunk) => ((chunk.choices as JsonMap[])[0]!.delta ?? {}) as JsonMap);
  assert.ok(deltas.some((delta) => delta.content === "hel"));
  assert.ok(deltas.some((delta) => Array.isArray(delta.tool_calls)));
  assert.ok(deltas.some((delta) => JSON.stringify(delta.thinking_blocks ?? []).includes("Q-PaDgsig")));
  const last = chunks.at(-1)!;
  assert.equal((last.choices as JsonMap[])[0]!.finish_reason, "tool_calls");
  assert.equal((last.usage as JsonMap).prompt_tokens, 10);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0], [
    { scope: "", usedPercent: 10, windowSeconds: 18_000, resetsAt: new Date(1_792_272_519_000).toISOString(), limitReached: false },
    { scope: "", usedPercent: 80, windowSeconds: 604_800, resetsAt: new Date(1_792_368_000_000).toISOString(), limitReached: false },
  ]);
});

test("Muse completions assemble the streamed answer and stream errors keep the quota reset", async () => {
  const { museCompletion, museFailure } = await import("@/lib/gateway/upstreams/muse");
  const json = museCompletion(
    sse([
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ]),
    "muse",
  );
  const choice = (json.choices as JsonMap[])[0]!;
  assert.equal((choice.message as JsonMap).content, "Hi");
  assert.equal(choice.finish_reason, "stop");
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const failure = museFailure({ type: "error", error: { code: 429, message: "Subscription quota exhausted.", resets_at: resets } });
  assert.ok(failure instanceof GateError);
  assert.equal(failure.status, 429);
  assert.equal(failure.retryAt, resets * 1000);
  assert.throws(
    () => museCompletion(sse([{ type: "response.failed", response: { error: { message: "boom" } } }]), "muse"),
    (error: unknown) => error instanceof GateError && error.status === 502 && error.message === "boom",
  );
});

test("Kimi usage payloads become plan windows", async () => {
  const { kimiLimits } = await import("@/lib/gateway/upstreams/kimi");
  const now = Date.parse("2026-10-20T10:00:00Z");
  const limits = kimiLimits(
    {
      usage: { limit: "100", remaining: "25", resetTime: "2026-10-27T00:00:00.123456789Z" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 50, used: 50, reset_in: 600 } },
        { name: "Search", detail: { limit: 0, used: 0 } },
      ],
    },
    "Andante",
    now,
  );
  assert.equal(limits.plan, "Andante");
  assert.deepEqual(limits.windows, [
    { scope: "", usedPercent: 100, windowSeconds: 18_000, resetsAt: "2026-10-20T10:10:00.000Z", limitReached: true },
    { scope: "", usedPercent: 75, windowSeconds: 604_800, resetsAt: "2026-10-27T00:00:00.123Z", limitReached: false },
  ]);
  assert.deepEqual(kimiLimits({}, "", now).windows, []);
});

test("Kimi plan limits read the usage endpoint with the account's headers", async () => {
  const { fetchSubscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("k1", { access: "kimi-access", refresh: "kr", accountId: "u", residency: "", device: "dev-1" }, Date.now() + 3_600_000);
  respondWith(() => Response.json({ usage: { limit: 10, used: 1 } }));
  const limits = await fetchSubscriptionLimits({ id: "k1", kind: "kimi_ai", apiKey: "" });
  assert.equal(calls[0]!.url, "https://api.kimi.ai/coding/v1/usages");
  assert.equal(calls[0]!.headers.Authorization, "Bearer kimi-access");
  assert.equal(calls[0]!.headers["X-Msh-Device-Id"], "dev-1");
  assert.equal(limits?.windows[0]?.usedPercent, 10);
  respondWith(() => new Response("", { status: 401 }));
  await assert.rejects(fetchSubscriptionLimits({ id: "k1", kind: "kimi_ai", apiKey: "" }), { message: "UPSTREAM_AUTH" });
});

test("Muse plan reads keep the stored plan without calling the provider", async () => {
  const { fetchSubscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("m1", { access: "LLM|key", refresh: "dca:abc", accountId: "", residency: "" }, Date.UTC(9999, 0, 1), "Muse Pro");
  respondWith(() => new Response("", { status: 500 }));
  const limits = await fetchSubscriptionLimits({ id: "m1", kind: "muse_code", apiKey: "" });
  assert.equal(limits?.plan, "Muse Pro");
  assert.deepEqual(limits?.windows, []);
  assert.equal(calls.length, 0);
});

test("observed windows survive full reads that carry none", async () => {
  const { observedWindowsBefore } = await import("@/lib/gateway/upstreams/observed-limits");
  const now = Date.parse("2026-10-20T10:00:00Z");
  const live = { scope: "", usedPercent: 40, windowSeconds: 18_000, resetsAt: "2026-10-20T12:00:00.000Z", limitReached: false };
  const stale = { ...live, windowSeconds: 604_800, resetsAt: "2026-10-20T09:00:00.000Z" };
  const scoped = { ...live, scope: "Sonnet" };
  assert.deepEqual(observedWindowsBefore([live, stale, scoped], [], now), [live]);
  assert.deepEqual(observedWindowsBefore([live], [{ ...live, usedPercent: 1 }], now), []);
});

test("Meta discovery falls back to the known Muse models when the list is unavailable", async () => {
  const { museModels } = await import("@/lib/gateway/upstreams/muse");
  const ids = museModels().map((model) => model.id);
  assert.ok(ids.includes("muse-spark-1.3"));
  assert.ok(ids.includes("muse-wonder-1.0"));
  assert.ok(museModels().every((model) => model.ownedBy === "meta" && model.contextLength > 0));
});
