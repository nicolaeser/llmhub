import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { ResolvedModelGroup } from "@/types/routing";
import type { SignInSession } from "@/types/providers";

type FakeLogin = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  leaseUntil: Date | null;
  refreshedAt?: Date | null;
  retryAt?: Date | null;
  failures?: number;
};

const logins = new Map<string, FakeLogin>();
const loginKinds = new Map<string, string>();
const policyRows: { kind: string; strategy: string }[] = [];

const fakePrisma = {
  accountRouting: {
    findMany: async () => policyRows.map((row) => ({ ...row })),
  },
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    findMany: async ({ where }: { where: { status: string; expiresAt: { lte: Date } } }) =>
      [...logins.values()]
        .filter((row) => row.status === where.status && row.expiresAt <= where.expiresAt.lte)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .map((row) => ({ ...row, provider: { kind: loginKinds.get(row.providerId) ?? "codex" } })),
    updateMany: async ({
      where,
      data,
    }: {
      where: { providerId: string; version: number; status?: string; OR?: unknown[] };
      data: Partial<FakeLogin> & { version?: { increment: number } };
    }) => {
      const row = logins.get(where.providerId);
      if (!row || row.version !== where.version) return { count: 0 };
      if (where.status && row.status !== where.status) return { count: 0 };
      if (where.OR && row.leaseUntil && row.leaseUntil.getTime() >= Date.now()) return { count: 0 };
      const { version, ...rest } = data;
      Object.assign(row, rest);
      if (version) row.version += version.increment;
      return { count: 1 };
    },
    update: async ({
      where,
      data,
    }: {
      where: { providerId: string };
      data: Partial<FakeLogin> & { version?: { increment: number } };
    }) => {
      const row = logins.get(where.providerId)!;
      const { version, ...rest } = data;
      Object.assign(row, rest);
      if (version) row.version += version.increment;
      return { ...row };
    },
  },
};

(globalThis as { prisma?: unknown }).prisma = fakePrisma;

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

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;

const openaiIdToken = jwt({
  email: "dev@example.com",
  "https://api.openai.com/auth": {
    chatgpt_account_id: "acct_1",
    chatgpt_plan_type: "pro",
    chatgpt_data_residency: "eu",
  },
});

beforeEach(() => {
  calls = [];
  logins.clear();
  loginKinds.clear();
  policyRows.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sign-in kinds are the subscription providers", async () => {
  const { isSignInKind } = await import("@/lib/gateway/upstreams/provider-kinds");
  assert.equal(isSignInKind("codex"), true);
  assert.equal(isSignInKind("grok_build"), true);
  assert.equal(isSignInKind("claude"), true);
  assert.equal(isSignInKind("openai"), false);
  assert.equal(isSignInKind("anthropic"), false);
});

test("OpenAI sessions read the account, plan, residency, and token expiry from the JWTs", async () => {
  const { openaiSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const exp = inOneHour();
  const session = openaiSession({ access_token: jwt({ exp }), refresh_token: "r1", id_token: openaiIdToken });
  assert.deepEqual(session, {
    tokens: { access: jwt({ exp }), refresh: "r1", accountId: "acct_1", residency: "eu" },
    expiresAt: exp * 1000,
    account: "dev@example.com",
    plan: "pro",
  });
  const refreshed = openaiSession({ access_token: "opaque", expires_in: 60 }, 1_000, session);
  assert.equal(refreshed.tokens.refresh, "r1");
  assert.equal(refreshed.tokens.accountId, "acct_1");
  assert.equal(refreshed.expiresAt, 61_000);
  assert.equal(refreshed.account, "dev@example.com");
});

test("xAI sessions use the id token email and expires_in", async () => {
  const { xaiSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const session = xaiSession(
    { access_token: "opaque", refresh_token: "r2", expires_in: 1800, id_token: jwt({ email: "grok@example.com" }) },
    0,
  );
  assert.equal(session.account, "grok@example.com");
  assert.equal(session.expiresAt, 1_800_000);
  assert.deepEqual(session.tokens, { access: "opaque", refresh: "r2", accountId: "", residency: "" });
});

test("Codex device sign-in polls until approval and exchanges the code with PKCE", async () => {
  const { pollDeviceCode, requestOpenaiDeviceCode } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  let approved = false;
  respondWith((url) => {
    if (url.endsWith("/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" });
    }
    if (url.endsWith("/deviceauth/token")) {
      return approved
        ? Response.json({ authorization_code: "code_1", code_verifier: "verifier_1", code_challenge: "c" })
        : new Response("", { status: 403 });
    }
    return Response.json({ access_token: jwt({ exp: inOneHour() }), refresh_token: "r1", id_token: openaiIdToken });
  });
  const device = await requestOpenaiDeviceCode();
  assert.equal(device.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(device.userCode, "ABCD-1234");
  assert.equal(device.interval, 5);
  assert.deepEqual(JSON.parse(calls[0]!.body), { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  assert.deepEqual(await pollDeviceCode(device.grant), { state: "pending", slowDown: false });
  approved = true;
  const done = await pollDeviceCode(device.grant);
  assert.equal(done.state, "done");
  assert.equal(done.state === "done" && done.session.tokens.accountId, "acct_1");
  const exchange = calls.at(-1)!;
  assert.equal(exchange.url, "https://auth.openai.com/oauth/token");
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code_1");
  assert.equal(form.get("code_verifier"), "verifier_1");
  assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
});

test("xAI device sign-in follows the RFC 8628 polling states", async () => {
  const { pollDeviceCode, requestXaiDeviceCode } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  let reply: Response = Response.json({ error: "authorization_pending" }, { status: 400 });
  respondWith((url) =>
    url.endsWith("/device/code")
      ? Response.json({
          device_code: "dc_1",
          user_code: "WXYZ",
          verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?code=WXYZ",
          expires_in: 600,
          interval: 3,
        })
      : reply,
  );
  const device = await requestXaiDeviceCode();
  assert.equal(device.verificationUrl, "https://accounts.x.ai/device?code=WXYZ");
  assert.equal(device.expiresIn, 600);
  const request = new URLSearchParams(calls[0]!.body);
  assert.match(request.get("scope") ?? "", /offline_access/);
  assert.deepEqual(await pollDeviceCode(device.grant), { state: "pending", slowDown: false });
  reply = Response.json({ error: "slow_down" }, { status: 400 });
  assert.deepEqual(await pollDeviceCode(device.grant), { state: "pending", slowDown: true });
  reply = Response.json({ error: "access_denied" }, { status: 400 });
  assert.deepEqual(await pollDeviceCode(device.grant), { state: "denied" });
  reply = Response.json({ error: "expired_token" }, { status: 400 });
  assert.deepEqual(await pollDeviceCode(device.grant), { state: "expired" });
  reply = Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  const done = await pollDeviceCode(device.grant);
  assert.equal(done.state, "done");
  assert.equal(new URLSearchParams(calls.at(-1)!.body).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
});

test("sealed tickets and credentials are bound to the user, kind, and lifetime", async () => {
  const { openCredential, openTicket, sealCredential, sealTicket } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const device = {
    grant: { kind: "grok_build" as const, deviceCode: "plaintext-device-code" },
    verificationUrl: "https://accounts.x.ai/device",
    userCode: "X",
    interval: 5,
    expiresIn: 600,
  };
  const ticket = sealTicket("u1", device, 0);
  assert.equal(ticket.includes("plaintext-device-code"), false);
  assert.deepEqual(openTicket(ticket, "u1", 1)?.grant, device.grant);
  assert.equal(openTicket(ticket, "u2", 1), null);
  assert.equal(openTicket(ticket, "u1", 600_001), null);
  assert.equal(openTicket("garbage", "u1", 1), null);
  const session: SignInSession = {
    tokens: { access: "a", refresh: "r", accountId: "", residency: "" },
    expiresAt: 1,
    account: "x@example.com",
    plan: "",
  };
  const credential = sealCredential("u1", "grok_build", session, 0);
  assert.deepEqual(openCredential(credential, "u1", "grok_build", 1)?.session, session);
  assert.equal(openCredential(credential, "u1", "codex", 1), null);
  assert.equal(openCredential(credential, "u2", "grok_build", 1), null);
  assert.equal(openCredential(credential, "u1", "grok_build", 31 * 60_000), null);
});

test("Codex requests identify LLM Hub and carry the ChatGPT workspace headers", async () => {
  const { signInHeaders } = await import("@/lib/gateway/upstreams/credentials");
  const headers = signInHeaders("codex", { access: "a", refresh: "r", accountId: "acct_1", residency: "eu" });
  assert.equal(headers["ChatGPT-Account-ID"], "acct_1");
  assert.equal(headers.originator, "llmhub");
  assert.match(headers["User-Agent"] ?? "", /^LLMHub\//);
  assert.equal(headers["x-openai-internal-codex-residency"], "eu");
  assert.deepEqual(signInHeaders("grok_build", { access: "a", refresh: "r", accountId: "", residency: "" }), {});
});

async function seedLogin(providerId: string, expiresAt: number, refresh = "r1", kind = "codex") {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  loginKinds.set(providerId, kind);
  logins.set(providerId, {
    providerId,
    account: "dev@example.com",
    plan: "pro",
    tokens: sealTokens({ access: "old-access", refresh, accountId: "acct_1", residency: "" }),
    expiresAt: new Date(expiresAt),
    status: "active",
    version: 0,
    leaseUntil: null,
    refreshedAt: null,
    retryAt: null,
    failures: 0,
  });
}

test("provider auth uses a fresh session without refreshing", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p1", Date.now() + 3_600_000);
  respondWith(() => {
    throw new Error("no refresh expected");
  });
  const auth = await providerAuth({ id: "p1", kind: "codex", apiKey: "" });
  assert.equal(auth.key, "old-access");
  assert.equal(auth.headers["ChatGPT-Account-ID"], "acct_1");
  assert.equal(calls.length, 0);
});

test("provider auth refreshes an expiring session once and stores the rotated tokens", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p2", Date.now() + 60_000);
  const exp = inOneHour();
  respondWith(() => Response.json({ access_token: jwt({ exp }), refresh_token: "r2" }));
  const [first, second] = await Promise.all([
    providerAuth({ id: "p2", kind: "codex", apiKey: "" }),
    providerAuth({ id: "p2", kind: "codex", apiKey: "" }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: "r1",
  });
  assert.equal(first.key, jwt({ exp }));
  assert.equal(second.key, first.key);
  const row = logins.get("p2")!;
  assert.equal(row.version, 1);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.expiresAt.getTime(), exp * 1000);
  assert.equal(row.account, "dev@example.com");
  const again = await providerAuth({ id: "p2", kind: "codex", apiKey: "" });
  assert.equal(again.key, first.key);
  assert.equal(calls.length, 1);
});

test("a revoked refresh token marks the sign-in expired and fails closed", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  const { GateError } = await import("@/lib/gateway/errors");
  await seedLogin("p3", Date.now() - 1_000);
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(
    providerAuth({ id: "p3", kind: "grok_build", apiKey: "" }),
    (err: unknown) => err instanceof GateError && err.status === 503 && err.code === "no_provider_key",
  );
  assert.equal(logins.get("p3")!.status, "expired");
  await assert.rejects(providerAuth({ id: "p3", kind: "grok_build", apiKey: "" }), GateError);
  assert.equal(calls.length, 1);
});

test("a transient refresh failure keeps using a still valid access token", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p4", Date.now() + 60_000);
  respondWith(() => new Response("bad gateway", { status: 502 }));
  const auth = await providerAuth({ id: "p4", kind: "grok_build", apiKey: "" });
  assert.equal(auth.key, "old-access");
  assert.equal(logins.get("p4")!.status, "active");
  assert.equal(logins.get("p4")!.leaseUntil, null);
});

test("a failed refresh inside the skew window is not retried by every request", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p6", Date.now() + 60_000);
  respondWith(() => new Response("bad gateway", { status: 502 }));
  await providerAuth({ id: "p6", kind: "grok_build", apiKey: "" });
  const auth = await providerAuth({ id: "p6", kind: "grok_build", apiKey: "" });
  assert.equal(auth.key, "old-access");
  assert.equal(calls.length, 1);
  const row = logins.get("p6")!;
  assert.equal(row.failures, 1);
  assert.ok(row.retryAt!.getTime() > Date.now());
});

test("an expired token is refreshed on demand even while a retry is pending", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p7", Date.now() - 1_000);
  logins.get("p7")!.retryAt = new Date(Date.now() + 600_000);
  logins.get("p7")!.failures = 3;
  const exp = inOneHour();
  respondWith(() => Response.json({ access_token: jwt({ exp }), refresh_token: "r2" }));
  const auth = await providerAuth({ id: "p7", kind: "codex", apiKey: "" });
  assert.equal(auth.key, jwt({ exp }));
  const row = logins.get("p7")!;
  assert.equal(row.failures, 0);
  assert.equal(row.retryAt, null);
  assert.ok(row.refreshedAt instanceof Date);
});

test("the refresh lead follows the kind and never exceeds half the token lifetime", async () => {
  const { refreshDueAt } = await import("@/lib/gateway/upstreams/credentials");
  const expiresAt = new Date("2026-10-20T12:00:00Z");
  const hours = (n: number) => n * 3_600_000;
  assert.equal(refreshDueAt("claude", { expiresAt, refreshedAt: null, retryAt: null }), expiresAt.getTime() - hours(4));
  assert.equal(refreshDueAt("codex", { expiresAt, refreshedAt: null, retryAt: null }), expiresAt.getTime() - hours(96));
  assert.equal(
    refreshDueAt("claude", { expiresAt, refreshedAt: new Date(expiresAt.getTime() - hours(1)), retryAt: null }),
    expiresAt.getTime() - hours(0.5),
  );
  assert.equal(
    refreshDueAt("antigravity", { expiresAt, refreshedAt: new Date(expiresAt.getTime() - hours(1)), retryAt: null }),
    expiresAt.getTime() - hours(0.5),
  );
  const retryAt = new Date(expiresAt.getTime() - hours(1));
  assert.equal(refreshDueAt("claude", { expiresAt, refreshedAt: null, retryAt }), retryAt.getTime());
});

test("the sweep refreshes every login inside its lead and leaves the others alone", async () => {
  const { openTokens, refreshDueLogins } = await import("@/lib/gateway/upstreams/credentials");
  const hour = 3_600_000;
  await seedLogin("claude-due", Date.now() + 3 * hour, "rc1", "claude");
  await seedLogin("claude-fresh", Date.now() + 7 * hour, "rc2", "claude");
  await seedLogin("codex-due", Date.now() + 72 * hour, "rx1", "codex");
  await seedLogin("codex-fresh", Date.now() + 120 * hour, "rx2", "codex");
  await seedLogin("grok-expired", Date.now() - hour, "rg1", "grok_build");
  logins.get("claude-fresh")!.refreshedAt = new Date(Date.now() - hour);
  const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
  respondWith((url, body) => {
    const sent = new URL(url).hostname === "platform.claude.com" ? JSON.parse(body).refresh_token : body;
    return Response.json({ access_token: jwt({ exp, sent }), refresh_token: `next-${String(sent).slice(-3)}` });
  });
  assert.equal(await refreshDueLogins(), 3);
  const refreshed = calls.map((call) => new URL(call.url).hostname).sort();
  assert.deepEqual(refreshed, ["auth.openai.com", "auth.x.ai", "platform.claude.com"]);
  for (const id of ["claude-due", "codex-due", "grok-expired"]) {
    const row = logins.get(id)!;
    assert.equal(row.version, 1, id);
    assert.equal(row.status, "active", id);
    assert.equal(row.expiresAt.getTime(), exp * 1000, id);
    assert.notEqual(openTokens(row.tokens, id).refresh, "", id);
  }
  assert.equal(logins.get("claude-fresh")!.version, 0);
  assert.equal(logins.get("codex-fresh")!.version, 0);
  assert.equal(await refreshDueLogins(), 0);
  assert.equal(calls.length, 3);
});

test("a failing scheduled refresh backs off exponentially and keeps the valid token", async () => {
  const { providerAuth, refreshDueLogins } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("c1", Date.now() + 3 * 3_600_000, "rc1", "claude");
  respondWith(() => new Response("unavailable", { status: 503 }));
  assert.equal(await refreshDueLogins(), 0);
  const row = logins.get("c1")!;
  assert.equal(row.failures, 1);
  assert.equal(row.status, "active");
  assert.equal(row.leaseUntil, null);
  const firstDelay = row.retryAt!.getTime() - Date.now();
  assert.ok(firstDelay > 50_000 && firstDelay <= 60_000, String(firstDelay));
  assert.equal(await refreshDueLogins(), 0);
  assert.equal(calls.length, 1);
  row.retryAt = new Date(Date.now() - 1);
  await refreshDueLogins();
  assert.equal(calls.length, 2);
  const secondDelay = row.retryAt!.getTime() - Date.now();
  assert.ok(secondDelay > 110_000 && secondDelay <= 120_000, String(secondDelay));
  const auth = await providerAuth({ id: "c1", kind: "claude", apiKey: "" });
  assert.equal(auth.key, "old-access");
  assert.equal(calls.length, 2);
});

test("a revoked refresh token keeps serving the valid access token until it expires", async () => {
  const { providerAuth, refreshDueLogins } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("c2", Date.now() + 3 * 3_600_000, "rc1", "claude");
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await refreshDueLogins();
  assert.equal(logins.get("c2")!.status, "active");
  const auth = await providerAuth({ id: "c2", kind: "claude", apiKey: "" });
  assert.equal(auth.key, "old-access");
});

test("a rate-limited refresh waits for the token endpoint's Retry-After", async () => {
  const { refreshDueLogins } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("c3", Date.now() + 3 * 3_600_000, "rc1", "claude");
  respondWith(() => Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "600" } }));
  await refreshDueLogins();
  const delay = logins.get("c3")!.retryAt!.getTime() - Date.now();
  assert.ok(delay > 590_000 && delay <= 600_000, String(delay));
  assert.equal(logins.get("c3")!.status, "active");
});

test("a rejected access token whose refresh is revoked expires the sign-in", async () => {
  const { renewRejectedLogin } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("c4", Date.now() + 3 * 3_600_000, "rc1", "claude");
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  assert.equal(await renewRejectedLogin("c4", "claude"), false);
  assert.equal(logins.get("c4")!.status, "expired");
});

test("a refresh that loses the row to a new sign-in keeps the newer tokens", async () => {
  const { providerAuth, sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  await seedLogin("p8", Date.now() + 60_000);
  const exp = inOneHour();
  respondWith(() => {
    const row = logins.get("p8")!;
    row.tokens = sealTokens({ access: "signed-in-again", refresh: "r9", accountId: "acct_1", residency: "" });
    row.expiresAt = new Date(Date.now() + 3_600_000);
    row.version += 1;
    return Response.json({ access_token: jwt({ exp }), refresh_token: "r2" });
  });
  const auth = await providerAuth({ id: "p8", kind: "codex", apiKey: "" });
  assert.equal(auth.key, "signed-in-again");
});

test("API key providers keep their sealed key and need no sign-in row", async () => {
  const { providerAuth } = await import("@/lib/gateway/upstreams/credentials");
  const { seal } = await import("@/lib/crypto");
  const auth = await providerAuth({ id: "p5", kind: "openai", apiKey: seal("sk-test") });
  assert.deepEqual(auth, { key: "sk-test", headers: {} });
});

const usagePayload = {
  plan_type: "pro",
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: 600, reset_at: 0 },
    secondary_window: { used_percent: 42, limit_window_seconds: 604_800, reset_after_seconds: 0, reset_at: 1_800_000_000 },
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_after_seconds: 60, reset_at: 1_700_000_060 },
      },
    },
  ],
  credits: { has_credits: true, unlimited: false, balance: "12.5" },
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 1 },
};

test("Codex usage maps plan windows, model specific limits, and credits", async () => {
  const { codexLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const limits = codexLimits(usagePayload, 1_000_000);
  assert.equal(limits.plan, "pro");
  assert.deepEqual(limits.windows, [
    { scope: "", usedPercent: 100, windowSeconds: 18_000, resetsAt: new Date(1_600_000).toISOString(), limitReached: true },
    {
      scope: "",
      usedPercent: 42,
      windowSeconds: 604_800,
      resetsAt: new Date(1_800_000_000_000).toISOString(),
      limitReached: false,
    },
    {
      scope: "GPT-5.3-Codex-Spark",
      usedPercent: 7,
      windowSeconds: 18_000,
      resetsAt: new Date(1_700_000_060_000).toISOString(),
      limitReached: false,
    },
  ]);
  assert.deepEqual(limits.credits, { unlimited: false, balance: "12.5" });
  assert.deepEqual(limits.resetCredits, { available: 3, applicable: 1 });
  assert.deepEqual(codexLimits({}, 0).windows, []);
  assert.equal(codexLimits({}, 0).credits, null);
  assert.equal(codexLimits({}, 0).resetCredits, null);
});

test("subscription limits come from the ChatGPT usage endpoint and are cached", async () => {
  const { subscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("p6", Date.now() + 3_600_000);
  respondWith(() => Response.json(usagePayload));
  assert.equal(await subscriptionLimits({ id: "p7", kind: "openai", apiKey: "" }), null);
  assert.equal(calls.length, 0);
  const first = await subscriptionLimits({ id: "p6", kind: "codex", apiKey: "" });
  assert.equal(first?.windows.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0]!.headers.Authorization, "Bearer old-access");
  assert.equal(calls[0]!.headers["ChatGPT-Account-ID"], "acct_1");
  assert.equal(await subscriptionLimits({ id: "p6", kind: "codex", apiKey: "" }), first);
  assert.equal(await subscriptionLimits({ id: "p6", kind: "codex", apiKey: "" }, { force: true }), first);
  assert.equal(calls.length, 1);
});

test("subscription limits report rejected and expired sign-ins as codes", async () => {
  const { subscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("p8", Date.now() + 3_600_000);
  respondWith(() => new Response("", { status: 401 }));
  await assert.rejects(subscriptionLimits({ id: "p8", kind: "codex", apiKey: "" }), { message: "UPSTREAM_AUTH" });
  await assert.rejects(subscriptionLimits({ id: "missing", kind: "codex", apiKey: "" }), { message: "SIGN_IN_EXPIRED" });
});

const claudeUsagePayload = {
  five_hour: { utilization: 100, resets_at: "2026-10-12T15:00:00.000000+00:00" },
  seven_day: { utilization: 41.5, resets_at: "2026-10-15T09:00:00+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12, resets_at: null },
  extra_usage: { is_enabled: false },
};

test("Claude sign-in builds a PKCE authorization URL and a sealed grant", async () => {
  const { requestAuthorizationCode } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const { signInMethod } = await import("@/lib/gateway/upstreams/provider-kinds");
  const device = requestAuthorizationCode();
  assert.equal(signInMethod("claude"), "code");
  assert.equal(signInMethod("codex"), "device");
  assert.equal(device.userCode, "");
  const url = new URL(device.verificationUrl);
  assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope") ?? "", /user:inference/);
  assert.equal(device.grant.kind, "claude");
  const grant = device.grant as { kind: "claude"; verifier: string; state: string };
  assert.equal(url.searchParams.get("state"), grant.state);
  const { createHash } = await import("node:crypto");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(grant.verifier).digest("base64url"));
});

test("pasted Claude authorization input accepts a callback URL, code#state, or a bare code", async () => {
  const { parseAuthorizationInput } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  assert.deepEqual(parseAuthorizationInput(" http://localhost:54545/callback?code=c1&state=s1 "), { code: "c1", state: "s1" });
  assert.deepEqual(parseAuthorizationInput("c2#s2"), { code: "c2", state: "s2" });
  assert.deepEqual(parseAuthorizationInput("c3"), { code: "c3", state: "" });
  assert.deepEqual(parseAuthorizationInput("http://%"), { code: "", state: "" });
});

test("Claude authorization exchanges the code with the verifier and reads account and plan", async () => {
  const { completeAuthorization, requestAuthorizationCode } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const device = requestAuthorizationCode();
  const grant = device.grant as { kind: "claude"; verifier: string; state: string };
  respondWith((url) =>
    url.endsWith("/oauth/profile")
      ? Response.json({
          account: { has_claude_max: true, has_claude_pro: false },
          organization: { rate_limit_tier: "default_claude_max_5x" },
        })
      : Response.json({
          access_token: "sk-ant-oat01-a",
          refresh_token: "sk-ant-ort01-r",
          expires_in: 28_800,
          account: { uuid: "acc-1", email_address: "dev@example.com" },
        }),
  );
  const session = await completeAuthorization(grant, `code-1#${grant.state}`);
  assert.equal(session.account, "dev@example.com");
  assert.equal(session.plan, "max_5x");
  assert.equal(session.tokens.access, "sk-ant-oat01-a");
  assert.equal(session.tokens.refresh, "sk-ant-ort01-r");
  assert.equal(session.tokens.accountId, "acc-1");
  const exchange = calls[0]!;
  assert.equal(exchange.url, "https://platform.claude.com/v1/oauth/token");
  assert.deepEqual(JSON.parse(exchange.body), {
    grant_type: "authorization_code",
    code: "code-1",
    redirect_uri: "http://localhost:54545/callback",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    code_verifier: grant.verifier,
    state: grant.state,
  });
  assert.equal(calls[1]!.headers.Authorization, "Bearer sk-ant-oat01-a");
  assert.match(calls[1]!.headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
});

test("Claude authorization rejects a foreign state, an empty code, and a failed exchange", async () => {
  const { completeAuthorization, requestAuthorizationCode } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  const grant = requestAuthorizationCode().grant as { kind: "claude"; verifier: string; state: string };
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(completeAuthorization(grant, "code#other-state"), { message: "SIGN_IN_FAILED" });
  await assert.rejects(completeAuthorization(grant, "   "), { message: "SIGN_IN_FAILED" });
  assert.equal(calls.length, 0);
  await assert.rejects(completeAuthorization(grant, "code"), { message: "SIGN_IN_FAILED" });
  assert.equal(calls.length, 1);
});

test("Claude plans come from the rate limit tier, then the subscription flags", async () => {
  const { claudePlan } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  assert.equal(claudePlan({ organization: { rate_limit_tier: "default_claude_max_20x" } }), "max_20x");
  assert.equal(claudePlan({ account: { has_claude_max: true } }), "max");
  assert.equal(claudePlan({ account: { has_claude_pro: true } }), "pro");
  assert.equal(claudePlan({ organization: { organization_type: "claude_team" } }), "team");
  assert.equal(claudePlan({}), "");
});

test("Claude sign-in refresh rotates both tokens and keeps the account", async () => {
  const { refreshSession } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  respondWith(() => Response.json({ access_token: "new-a", refresh_token: "new-r", expires_in: 100 }));
  const outcome = await refreshSession("claude", {
    tokens: { access: "old-a", refresh: "old-r", accountId: "acc-1", residency: "" },
    expiresAt: 0,
    account: "dev@example.com",
    plan: "pro",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.tokens.refresh, "new-r");
  assert.equal(outcome.session.tokens.accountId, "acc-1");
  assert.equal(outcome.session.account, "dev@example.com");
  assert.equal(outcome.session.plan, "pro");
  const body = JSON.parse(calls[0]!.body) as Record<string, string>;
  assert.equal(calls[0]!.url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "old-r");
});

test("Claude usage maps the five hour, weekly, and model weekly windows", async () => {
  const { claudeLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const limits = claudeLimits(claudeUsagePayload, "max_5x", 0);
  assert.equal(limits.plan, "max_5x");
  assert.deepEqual(limits.windows, [
    {
      scope: "",
      usedPercent: 100,
      windowSeconds: 18_000,
      resetsAt: "2026-10-12T15:00:00.000Z",
      limitReached: true,
    },
    {
      scope: "",
      usedPercent: 41.5,
      windowSeconds: 604_800,
      resetsAt: "2026-10-15T09:00:00.000Z",
      limitReached: false,
    },
    { scope: "Sonnet", usedPercent: 12, windowSeconds: 604_800, resetsAt: null, limitReached: false },
  ]);
  assert.equal(limits.resetCredits, null);
  assert.deepEqual(claudeLimits({}, "", 0).windows, []);
});

test("Claude subscription limits call the OAuth usage endpoint with the beta header", async () => {
  const { subscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("p9", Date.now() + 3_600_000);
  respondWith(() => Response.json(claudeUsagePayload));
  const limits = await subscriptionLimits({ id: "p9", kind: "claude", apiKey: "" });
  assert.equal(limits?.plan, "pro");
  assert.equal(limits?.windows.length, 3);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(calls[0]!.headers.Authorization, "Bearer old-access");
  assert.match(calls[0]!.headers["anthropic-beta"] ?? "", /oauth-2025-04-20/);
});

type PoolDeployment = ReturnType<typeof poolDeployment>;

function poolDeployment(id: string, weight: number) {
  return {
    id: `dep-${id}`,
    kind: "claude",
    base_url: "",
    model: "claude-sonnet-4-5",
    weight,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: `prov-${id}`,
    provider: {
      id: `prov-${id}`,
      kind: "claude",
      baseUrl: "",
      apiKey: "",
      zdr: false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
      assignments: [] as { orgId: string | null; teamId: string | null; projectId: string | null; memberId: string | null; keyId: string | null }[],
    },
  };
}

async function claudePool(): Promise<{ group: ResolvedModelGroup; mapped: PoolDeployment[] }> {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  const usage: Record<string, unknown> = {
    "token-q1": { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() } },
    "token-q2": {
      five_hour: { utilization: 20, resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString() },
      seven_day: { utilization: 60, resets_at: new Date(Date.now() + 72 * 3_600_000).toISOString() },
    },
    "token-q3": {
      five_hour: { utilization: 10, resets_at: new Date(Date.now() + 1 * 3_600_000).toISOString() },
      seven_day: { utilization: 30, resets_at: new Date(Date.now() + 1 * 3_600_000).toISOString() },
    },
  };
  for (const id of ["q1", "q2", "q3"]) {
    logins.set(`prov-${id}`, {
      providerId: `prov-${id}`,
      account: `${id}@example.com`,
      plan: "max",
      tokens: sealTokens({ access: `token-${id}`, refresh: "r", accountId: "", residency: "" }),
      expiresAt: new Date(Date.now() + 3_600_000),
      status: "active",
      version: 0,
      leaseUntil: null,
    });
  }
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    return Response.json(usage[auth]);
  }) as typeof fetch;
  const mapped = [poolDeployment("q1", 10), poolDeployment("q2", 5), poolDeployment("q3", 1)];
  const group: ResolvedModelGroup = {
    alias: "claude-pool",
    strategy: "priority",
    billing_mode: "routed",
    price_input_per_1k: 0,
    price_output_per_1k: 0,
    price_time_zone: "UTC",
    price_windows: [],
    overflow_group: "",
    num_retries: 0,
    fallback_groups: [],
    deployments: mapped,
    mapped,
  };
  return { group, mapped };
}

test("routing skips subscription accounts at a limit and follows the quota strategies", async () => {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  const { group, mapped } = await claudePool();
  const pickFor = async (strategy: string) => {
    const acquired = await acquireGroup({ ...group, strategy }, undefined, undefined, "");
    acquired.release();
    return acquired.dep.id;
  };
  assert.equal(await pickFor("priority"), "dep-q2");
  const paused = poolDeployment("q2", 5);
  paused.provider.enabled = false;
  const withPaused: ResolvedModelGroup = { ...group, mapped: [mapped[0]!, paused, mapped[2]!] };
  const acquiredPaused = await acquireGroup(withPaused, undefined, undefined, "priority");
  acquiredPaused.release();
  assert.equal(acquiredPaused.dep.id, "dep-q3");
  assert.equal(await pickFor("quota_balanced"), "dep-q3");
  assert.equal(await pickFor("quota_expiring"), "dep-q3");
  const rotation = [await pickFor("round_robin"), await pickFor("round_robin"), await pickFor("round_robin")];
  assert.deepEqual(rotation, [rotation[0], rotation[1], rotation[0]]);
  assert.notEqual(rotation[0], rotation[1]);
  assert.equal(new Set(rotation).size, 2);
  assert.equal(rotation.includes("dep-q1"), false);
});

test("a per provider account policy decides between accounts of that provider before the alias strategy", async () => {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  const { forgetAccountPolicies } = await import("@/lib/gateway/routing/account-routing");
  const { group } = await claudePool();
  const pickFor = async () => {
    const acquired = await acquireGroup(group, undefined, undefined, "");
    acquired.release();
    return acquired.dep.id;
  };
  forgetAccountPolicies();
  assert.equal(await pickFor(), "dep-q2");
  policyRows.push({ kind: "claude", strategy: "inherit" });
  forgetAccountPolicies();
  assert.equal(await pickFor(), "dep-q2");
  policyRows[0] = { kind: "claude", strategy: "quota_balanced" };
  forgetAccountPolicies();
  assert.equal(await pickFor(), "dep-q3");
  policyRows[0] = { kind: "claude", strategy: "smart" };
  forgetAccountPolicies();
  assert.equal(await pickFor(), "dep-q3");
  policyRows[0] = { kind: "claude", strategy: "round_robin" };
  forgetAccountPolicies();
  const rotation = [await pickFor(), await pickFor(), await pickFor()];
  assert.equal(new Set(rotation).size, 2);
  assert.equal(rotation.includes("dep-q1"), false);
  policyRows[0] = { kind: "codex", strategy: "round_robin" };
  forgetAccountPolicies();
  assert.equal(await pickFor(), "dep-q2");
  forgetAccountPolicies();
});

test("restricted accounts only serve the keys, people, projects, departments, and companies assigned to them", async () => {
  const { acquireGroup } = await import("@/lib/gateway/routing/runtime");
  const { ERR_NOT_ASSIGNED } = await import("@/lib/gateway/core");
  const { group, mapped } = await claudePool();
  const none = { orgId: null, teamId: null, projectId: null, memberId: null, keyId: null };
  const caller = { orgId: "org-1", teamId: "team-1", projectId: "proj-1", memberId: "mem-1", keyId: "key-1" };
  const pickFor = async (access: typeof caller | null) => {
    const acquired = await acquireGroup(group, undefined, undefined, "priority", undefined, access);
    acquired.release();
    return acquired.dep.id;
  };
  const q2 = mapped[1]!.provider;
  q2.restricted = true;
  q2.assignments = [{ ...none, keyId: "key-9" }];
  assert.equal(await pickFor(null), "dep-q3");
  assert.equal(await pickFor(caller), "dep-q3");
  q2.assignments = [{ ...none, keyId: "key-1" }];
  assert.equal(await pickFor(caller), "dep-q2");
  assert.equal(await pickFor(null), "dep-q3");
  for (const assigned of [{ memberId: "mem-1" }, { projectId: "proj-1" }, { teamId: "team-1" }, { orgId: "org-1" }]) {
    q2.assignments = [{ ...none, ...assigned }];
    assert.equal(await pickFor(caller), "dep-q2", JSON.stringify(assigned));
    assert.equal(await pickFor({ ...caller, orgId: "org-2", teamId: "team-2", projectId: "p", memberId: "m", keyId: "k" }), "dep-q3");
  }
  q2.assignments = [];
  assert.equal(await pickFor(caller), "dep-q3");
  for (const row of [mapped[0]!, mapped[2]!]) {
    row.provider.restricted = true;
    row.provider.assignments = [];
  }
  await assert.rejects(pickFor(caller), (err: unknown) => err === ERR_NOT_ASSIGNED);
  q2.restricted = false;
  assert.equal(await pickFor(caller), "dep-q2");
});

test("xAI billing maps the weekly credits, the monthly spend cap, and on-demand usage", async () => {
  const { xaiLimits } = await import("@/lib/gateway/upstreams/xai-limits");
  const limits = xaiLimits(
    {
      config: {
        currentPeriod: { type: "weekly", start: "2026-10-05T00:00:00Z", end: "2026-10-12T00:00:00Z" },
        creditUsagePercent: 37.5,
      },
    },
    {
      config: {
        monthlyLimit: { val: 3000 },
        used: { val: 4500 },
        onDemandCap: { val: 2000 },
        billingPeriodStart: "2026-10-01T00:00:00Z",
        billingPeriodEnd: "2026-11-01T00:00:00Z",
      },
    },
    "SuperGrok",
    0,
  );
  assert.equal(limits.plan, "SuperGrok");
  assert.deepEqual(limits.windows, [
    { scope: "", usedPercent: 37.5, windowSeconds: 604_800, resetsAt: "2026-10-12T00:00:00.000Z", limitReached: false },
    { scope: "", usedPercent: 100, windowSeconds: 2_678_400, resetsAt: "2026-11-01T00:00:00.000Z", limitReached: true },
  ]);
  assert.deepEqual(limits.extraUsage, { usedCents: 1500, limitCents: 2000, percent: 75 });
  assert.deepEqual(xaiLimits(null, null, "", 0).windows, []);
});

test("subscription limits for SuperGrok call the billing endpoints with the Grok CLI headers", async () => {
  const { subscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  await seedLogin("p10", Date.now() + 3_600_000);
  respondWith((url) =>
    url.endsWith("/v1/settings")
      ? Response.json({ subscription_tier_display: "SuperGrok Heavy" })
      : url.includes("format=credits")
        ? Response.json({ config: { currentPeriod: { start: "2026-10-05T00:00:00Z", end: "2026-10-12T00:00:00Z" }, creditUsagePercent: 10 } })
        : new Response("", { status: 404 }),
  );
  const limits = await subscriptionLimits({ id: "p10", kind: "grok_build", apiKey: "" });
  assert.equal(limits?.plan, "SuperGrok Heavy");
  assert.equal(limits?.windows.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(calls[0]!.headers.Authorization, "Bearer old-access");
  await seedLogin("p11", Date.now() + 3_600_000);
  respondWith(() => new Response("", { status: 401 }));
  await assert.rejects(subscriptionLimits({ id: "p11", kind: "grok_build", apiKey: "" }), { message: "UPSTREAM_AUTH" });
});
