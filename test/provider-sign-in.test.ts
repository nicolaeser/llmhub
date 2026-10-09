import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
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
};

const logins = new Map<string, FakeLogin>();

const fakePrisma = {
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { providerId: string; version: number; status: string };
      data: { leaseUntil: Date };
    }) => {
      const row = logins.get(where.providerId);
      const now = Date.now();
      if (!row || row.version !== where.version || row.status !== where.status) return { count: 0 };
      if (row.leaseUntil && row.leaseUntil.getTime() >= now) return { count: 0 };
      row.leaseUntil = data.leaseUntil;
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
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sign-in kinds are the subscription providers", async () => {
  const { isSignInKind } = await import("@/lib/gateway/catalog");
  assert.equal(isSignInKind("codex"), true);
  assert.equal(isSignInKind("grok_build"), true);
  assert.equal(isSignInKind("openai"), false);
  assert.equal(isSignInKind("anthropic"), false);
});

test("OpenAI sessions read the account, plan, residency, and token expiry from the JWTs", async () => {
  const { openaiSession } = await import("@/lib/gateway/sign-in");
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
  const { xaiSession } = await import("@/lib/gateway/sign-in");
  const session = xaiSession(
    { access_token: "opaque", refresh_token: "r2", expires_in: 1800, id_token: jwt({ email: "grok@example.com" }) },
    0,
  );
  assert.equal(session.account, "grok@example.com");
  assert.equal(session.expiresAt, 1_800_000);
  assert.deepEqual(session.tokens, { access: "opaque", refresh: "r2", accountId: "", residency: "" });
});

test("Codex device sign-in polls until approval and exchanges the code with PKCE", async () => {
  const { pollDeviceCode, requestDeviceCode } = await import("@/lib/gateway/sign-in");
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
  const device = await requestDeviceCode("codex");
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
  const { pollDeviceCode, requestDeviceCode } = await import("@/lib/gateway/sign-in");
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
  const device = await requestDeviceCode("grok_build");
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
  const { openCredential, openTicket, sealCredential, sealTicket } = await import("@/lib/gateway/sign-in");
  const device = {
    grant: { kind: "grok_build" as const, deviceCode: "dc" },
    verificationUrl: "https://accounts.x.ai/device",
    userCode: "X",
    interval: 5,
    expiresIn: 600,
  };
  const ticket = sealTicket("u1", device, 0);
  assert.equal(ticket.includes("dc"), false);
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
  const { signInHeaders } = await import("@/lib/gateway/credentials");
  const headers = signInHeaders("codex", { access: "a", refresh: "r", accountId: "acct_1", residency: "eu" });
  assert.equal(headers["ChatGPT-Account-ID"], "acct_1");
  assert.equal(headers.originator, "llmhub");
  assert.match(headers["User-Agent"] ?? "", /^LLMHub\//);
  assert.equal(headers["x-openai-internal-codex-residency"], "eu");
  assert.deepEqual(signInHeaders("grok_build", { access: "a", refresh: "r", accountId: "", residency: "" }), {});
});

async function seedLogin(providerId: string, expiresAt: number, refresh = "r1") {
  const { sealTokens } = await import("@/lib/gateway/credentials");
  logins.set(providerId, {
    providerId,
    account: "dev@example.com",
    plan: "pro",
    tokens: sealTokens({ access: "old-access", refresh, accountId: "acct_1", residency: "" }),
    expiresAt: new Date(expiresAt),
    status: "active",
    version: 0,
    leaseUntil: null,
  });
}

test("provider auth uses a fresh session without refreshing", async () => {
  const { providerAuth } = await import("@/lib/gateway/credentials");
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
  const { providerAuth } = await import("@/lib/gateway/credentials");
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
  const { providerAuth } = await import("@/lib/gateway/credentials");
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
  const { providerAuth } = await import("@/lib/gateway/credentials");
  await seedLogin("p4", Date.now() + 60_000);
  respondWith(() => new Response("bad gateway", { status: 502 }));
  const auth = await providerAuth({ id: "p4", kind: "grok_build", apiKey: "" });
  assert.equal(auth.key, "old-access");
  assert.equal(logins.get("p4")!.status, "active");
  assert.equal(logins.get("p4")!.leaseUntil, null);
});

test("API key providers keep their sealed key and need no sign-in row", async () => {
  const { providerAuth } = await import("@/lib/gateway/credentials");
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
};

test("Codex usage maps plan windows, model specific limits, and credits", async () => {
  const { codexLimits } = await import("@/lib/gateway/subscription-limits");
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
  assert.deepEqual(codexLimits({}, 0).windows, []);
  assert.equal(codexLimits({}, 0).credits, null);
});

test("subscription limits come from the ChatGPT usage endpoint and are cached", async () => {
  const { subscriptionLimits } = await import("@/lib/gateway/subscription-limits");
  await seedLogin("p6", Date.now() + 3_600_000);
  respondWith(() => Response.json(usagePayload));
  assert.equal(await subscriptionLimits({ id: "p7", kind: "grok_build", apiKey: "" }), null);
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
  const { subscriptionLimits } = await import("@/lib/gateway/subscription-limits");
  await seedLogin("p8", Date.now() + 3_600_000);
  respondWith(() => new Response("", { status: 401 }));
  await assert.rejects(subscriptionLimits({ id: "p8", kind: "codex", apiKey: "" }), { message: "UPSTREAM_AUTH" });
  await assert.rejects(subscriptionLimits({ id: "missing", kind: "codex", apiKey: "" }), { message: "SIGN_IN_EXPIRED" });
});
