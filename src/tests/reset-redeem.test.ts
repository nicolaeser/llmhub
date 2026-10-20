import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { limitSnapshotModel, snapshotRows } from "./support/limit-snapshot-fake";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";
import type { AutoResetPolicy, AutoUsage } from "@/types/resets";

delete process.env.REDIS_URL;

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
type FakeProvider = { id: string; kind: string; apiKey: string; enabled: boolean };
type RoutingRow = { kind: string; strategy: string; autoReset: boolean; autoResetPercent: number; autoResetScope: string };
type Sent = { url: string; method: string; body: JsonMap | null; auth: string };
type Reply = (call: Sent) => Response | Promise<Response>;

const settings = new Map<string, string>();
const logins = new Map<string, FakeLogin>();
const providers: FakeProvider[] = [];
const routing: RoutingRow[] = [];
const deployments: { id: string; providerId: string }[] = [];
const audits: { actor: string; action: string; objectId: string; afterJson: string }[] = [];
let sent: Sent[] = [];

function settingMatches(key: string, where: { key?: string | { startsWith: string }; value?: string | { lt: string } }) {
  const value = settings.get(key);
  if (value === undefined) return false;
  if (typeof where.key === "string" && where.key !== key) return false;
  if (typeof where.key === "object" && !key.startsWith(where.key.startsWith)) return false;
  if (typeof where.value === "string" && where.value !== value) return false;
  if (typeof where.value === "object" && !(value < where.value.lt)) return false;
  return true;
}

const fakePrisma = {
  setting: {
    create: async ({ data }: { data: { key: string; value: string } }) => {
      if (settings.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      settings.set(data.key, data.value);
      return { ...data };
    },
    deleteMany: async ({ where }: { where: { key?: string; value?: string | { lt: string } } }) => {
      const keys = [...settings.keys()].filter((key) => settingMatches(key, where));
      for (const key of keys) settings.delete(key);
      return { count: keys.length };
    },
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    findMany: async ({ where }: { where: { key: { startsWith: string } } }) =>
      [...settings.entries()].filter(([key]) => key.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }) => {
      settings.set(where.key, settings.has(where.key) ? update.value : create.value);
      return { key: where.key, value: settings.get(where.key) };
    },
  },
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    updateMany: async () => ({ count: 0 }),
    update: async ({ where }: { where: { providerId: string } }) => logins.get(where.providerId),
  },
  providerConnection: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = providers.find((item) => item.id === where.id);
      return row ? { ...row, login: { status: logins.get(row.id)?.status ?? "expired" } } : null;
    },
    findMany: async ({ where }: { where: { kind: string; enabled: boolean } }) =>
      providers
        .filter((row) => row.kind === where.kind && row.enabled === where.enabled && logins.get(row.id)?.status === "active")
        .map(({ id, kind, apiKey }) => ({ id, kind, apiKey })),
  },
  accountRouting: {
    findMany: async () => routing.map((row) => ({ ...row })),
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { kind: string };
      create: RoutingRow;
      update: Omit<RoutingRow, "kind" | "strategy">;
    }) => {
      const row = routing.find((item) => item.kind === where.kind);
      if (row) Object.assign(row, update);
      else routing.push({ ...create });
      return routing.find((item) => item.kind === where.kind);
    },
  },
  deployment: {
    findMany: async ({ where }: { where: { providerId: string } }) =>
      deployments.filter((row) => row.providerId === where.providerId).map((row) => ({ id: row.id })),
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: (typeof audits)[number] }) => {
      audits.push(data);
      return data;
    },
  },
  providerLimitSnapshot: limitSnapshotModel((id) => {
    const row = providers.find((item) => item.id === id);
    return row ? { kind: row.kind, enabled: row.enabled } : null;
  }),
};

(globalThis as { prisma?: unknown }).prisma = fakePrisma;

const realFetch = globalThis.fetch;
const ORG = "4f6c1f2e-8a3b-4c5d-9e7f-0123456789ab";
let counter = 0;

function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Date.now()}`;
}

function respond(reply: Reply) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === "string" ? init.body : "";
    const call: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      body: raw ? (JSON.parse(raw) as JsonMap) : null,
      auth: headers.Authorization ?? "",
    };
    sent.push(call);
    return reply(call);
  }) as typeof fetch;
}

async function addAccount(kind: string, change: Partial<FakeProvider> = {}): Promise<FakeProvider> {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  const id = change.id ?? uid(kind);
  logins.set(id, {
    providerId: id,
    account: `${id}@example.com`,
    plan: "pro",
    tokens: sealTokens({ access: `access-${id}`, refresh: "r1", accountId: "acct_1", residency: "" }),
    expiresAt: new Date(Date.now() + 3_600_000),
    status: "active",
    version: 0,
    leaseUntil: null,
  });
  const row = { id, kind, apiKey: "", enabled: true, ...change };
  providers.push(row);
  return row;
}

function owner(call: Sent): string {
  return call.auth.replace("Bearer access-", "");
}

function codexUsage(used: number, resetCredits: JsonMap | null = { available_count: 1, applicable_available_count: 1 }, resetIn = 3_600) {
  return Response.json({
    plan_type: "pro",
    rate_limit: {
      allowed: used < 100,
      limit_reached: used >= 100,
      primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: resetIn },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 400_000 },
    },
    ...(resetCredits ? { rate_limit_reset_credits: resetCredits } : {}),
  });
}

function codexCredits() {
  return Response.json({
    credits: [
      { id: "late", reset_type: "codex_rate_limits", status: "available", expires_at: "2099-01-01T00:00:00Z" },
      { id: "soon", reset_type: "codex_rate_limits", status: "available", expires_at: "2098-01-01T00:00:00Z" },
    ],
    available_count: 2,
    total_earned_count: 2,
    immediate_reset_purchase_eligible: false,
    history_enabled: true,
  });
}

function claudeBlock(atLimit: boolean, change: JsonMap = {}) {
  return Response.json({
    five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    cedar_ember: {
      eligible: true,
      at_limit: atLimit,
      grants: [
        { id: "launch_1", label: "Launch", resets_total: 1, resets_left: 1, usable_now: true, clears: ["five_hour"] },
        { id: "bonus_2", label: "Bonus", resets_total: 1, resets_left: 1, usable_now: true },
      ],
      next_grant_id: "bonus_2",
      ...change,
    },
  });
}

function claudeUsage(used: number) {
  return Response.json({ five_hour: { utilization: used, resets_at: new Date(Date.now() + 3_600_000).toISOString() } });
}

function routeCodex(consume: Reply, usage: (id: string) => Response = () => codexUsage(100)): Reply {
  return (call) => {
    if (call.url.endsWith("/wham/usage")) return usage(owner(call));
    if (call.url.endsWith("/rate-limit-reset-credits")) return codexCredits();
    if (call.url.endsWith("/rate-limit-reset-credits/consume")) return consume(call);
    throw new Error(`unexpected ${call.url}`);
  };
}

function routeClaude(claim: Reply, status: () => Response = () => claudeBlock(true), usage = () => claudeUsage(100)): Reply {
  return (call) => {
    if (call.url.includes("cedar_ember=1")) return status();
    if (call.url.endsWith("/api/oauth/usage")) return usage();
    if (call.url.endsWith("/api/oauth/profile")) return Response.json({ organization: { uuid: ORG } });
    if (call.url.endsWith("/reset_rate_limits")) return claim(call);
    throw new Error(`unexpected ${call.url}`);
  };
}

function consumes(): Sent[] {
  return sent.filter((call) => call.url.endsWith("/consume") || call.url.endsWith("/reset_rate_limits"));
}

function auditResults(providerId: string): string[] {
  return audits
    .filter((row) => row.objectId === providerId && row.action === "provider.reset_redeem")
    .map((row) => (JSON.parse(row.afterJson) as { result: string }).result);
}

function principal(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "session-1",
    user: { id: "user-1", username: "ops", email: "ops@example.test" } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function setPolicy(kind: string, policy: Partial<AutoResetPolicy>) {
  const index = routing.findIndex((row) => row.kind === kind);
  if (index >= 0) routing.splice(index, 1);
  routing.push({
    kind,
    strategy: "inherit",
    autoReset: policy.enabled ?? true,
    autoResetPercent: policy.percent ?? 99,
    autoResetScope: policy.scope ?? "account",
  });
}

beforeEach(async () => {
  sent = [];
  settings.clear();
  logins.clear();
  providers.length = 0;
  routing.length = 0;
  deployments.length = 0;
  audits.length = 0;
  snapshotRows.clear();
  const { forgetAccountPolicies } = await import("@/lib/gateway/routing/account-routing");
  forgetAccountPolicies();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("usage is the tightest plan window and the threshold picks due accounts", async () => {
  const { accountUsage, dueForReset } = await import("@/lib/gateway/upstreams/reset-redeem");
  const now = Date.now();
  const limits = {
    plan: "pro",
    windows: [
      { scope: "", usedPercent: 62, windowSeconds: 18_000, resetsAt: new Date(now + 60_000).toISOString(), limitReached: false },
      { scope: "", usedPercent: 99, windowSeconds: 604_800, resetsAt: new Date(now + 600_000).toISOString(), limitReached: false },
      { scope: "Spark", usedPercent: 100, windowSeconds: 18_000, resetsAt: null, limitReached: true },
    ],
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt: new Date(now).toISOString(),
  };
  assert.equal(accountUsage(limits, now), 99);
  assert.equal(accountUsage({ ...limits, windows: [{ ...limits.windows[0]!, limitReached: true }] }, now), 100);
  assert.equal(accountUsage({ ...limits, windows: [{ ...limits.windows[1]!, resetsAt: new Date(now - 1).toISOString() }] }, now), 0);
  assert.equal(accountUsage({ ...limits, windows: [] }, now), null);
  assert.equal(accountUsage(null, now), null);

  const usages: AutoUsage[] = [
    { id: "a", usage: 99, recovery: 10 },
    { id: "b", usage: 100, recovery: 30 },
    { id: "c", usage: 70, recovery: 0 },
  ];
  assert.deepEqual(dueForReset({ enabled: true, percent: 99, scope: "account" }, usages, null), ["b", "a"]);
  assert.deepEqual(dueForReset({ enabled: true, percent: 99, scope: "account" }, usages, "a"), ["a"]);
  assert.deepEqual(dueForReset({ enabled: true, percent: 99, scope: "account" }, usages, "c"), []);
  assert.deepEqual(dueForReset({ enabled: true, percent: 99, scope: "pool" }, usages, null), []);
  assert.deepEqual(dueForReset({ enabled: true, percent: 70, scope: "pool" }, usages, "a"), ["b", "a", "c"]);
  assert.deepEqual(dueForReset({ enabled: true, percent: 50, scope: "pool" }, [{ id: "x", usage: null, recovery: 0 }], null), []);
  assert.deepEqual(dueForReset({ enabled: true, percent: 50, scope: "pool" }, [], null), []);
});

test("the auto guard waits 15 minutes and never runs while a claim is unresolved", async () => {
  const { autoGuardOpen, AUTO_GUARD_MS } = await import("@/lib/gateway/upstreams/reset-redeem");
  const now = Date.now();
  assert.equal(autoGuardOpen({ pending: null, lastAutoAt: 0 }, now), true);
  assert.equal(autoGuardOpen({ pending: null, lastAutoAt: now - AUTO_GUARD_MS + 1 }, now), false);
  assert.equal(autoGuardOpen({ pending: null, lastAutoAt: now - AUTO_GUARD_MS }, now), true);
  const pending = { kind: "codex" as const, requestId: "r", startedAt: now, attempts: 1, trigger: "manual" as const, actor: "u" };
  assert.equal(autoGuardOpen({ pending, lastAutoAt: 0 }, now), false);
});

test("a manual Codex redeem spends the soonest credit, audits it, refreshes limits, and clears cooldowns", async () => {
  const { redeemReset, loadResetState } = await import("@/lib/gateway/upstreams/reset-redeem");
  const { coolingDown, recordFailure } = await import("@/lib/gateway/routing/provider-health");
  const account = await addAccount("codex");
  deployments.push({ id: `${account.id}-route`, providerId: account.id });
  recordFailure(`${account.id}-route`, Date.now(), Date.now() + 3_600_000);
  assert.equal((await coolingDown([`${account.id}-route`])).size, 1);
  let spent = false;
  respond(
    routeCodex(
      () => {
        spent = true;
        return Response.json({ code: "reset", windows_reset: 2 });
      },
      () => (spent ? codexUsage(0, { available_count: 1, applicable_available_count: 0 }) : codexUsage(100)),
    ),
  );
  const outcome = await redeemReset(account, { actor: "user-1", trigger: "manual" });
  assert.deepEqual(outcome, { result: "reset", windowsReset: 2 });
  const [consume] = consumes();
  assert.equal(consume?.body?.credit_id, "soon");
  assert.match(String(consume?.body?.redeem_request_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(await loadResetState(account.id), { pending: null, lastAutoAt: 0 });
  assert.deepEqual(auditResults(account.id), ["reset"]);
  const audit = audits.find((row) => row.objectId === account.id)!;
  assert.equal(audit.actor, "user-1");
  assert.doesNotMatch(audit.afterJson, /access-/);
  assert.equal((await coolingDown([`${account.id}-route`])).size, 0);
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  assert.equal(limitsSnapshot(account.id)?.windows[0]?.usedPercent, 0);
  assert.equal([...settings.keys()].some((key) => key.startsWith("provider_reset_lock:")), false);
});

test("a Codex redeem without an applicable reset never calls consume", async () => {
  const { redeemReset } = await import("@/lib/gateway/upstreams/reset-redeem");
  const account = await addAccount("codex");
  respond(
    routeCodex(
      () => Response.json({ code: "reset" }),
      () => codexUsage(100, { available_count: 2, applicable_available_count: 0 }),
    ),
  );
  await assert.rejects(redeemReset(account, { actor: "user-1", trigger: "manual" }), /RESET_NOT_AVAILABLE/);
  assert.equal(consumes().length, 0);
  assert.deepEqual(auditResults(account.id), []);
});

test("an unknown Codex outcome stays pending and the retry reuses the same redeem request id", async () => {
  const { redeemReset, loadResetState } = await import("@/lib/gateway/upstreams/reset-redeem");
  const account = await addAccount("codex");
  const answers = [new Response("bad gateway", { status: 502 }), Response.json({ code: "already_redeemed" })];
  respond(routeCodex(() => answers.shift()!));
  const first = await redeemReset(account, { actor: "user-1", trigger: "manual" });
  assert.equal(first.result, "unknown");
  const state = await loadResetState(account.id);
  assert.equal(state.pending?.attempts, 1);
  assert.equal(state.pending?.creditId, "soon");
  const second = await redeemReset(account, { actor: "user-2", trigger: "manual" });
  assert.equal(second.result, "already_redeemed");
  const [a, b] = consumes();
  assert.equal(a?.body?.redeem_request_id, b?.body?.redeem_request_id);
  assert.equal(b?.body?.credit_id, "soon");
  assert.deepEqual(await loadResetState(account.id), { pending: null, lastAutoAt: 0 });
  assert.deepEqual(auditResults(account.id), ["unknown", "already_redeemed"]);
});

test("an unknown Claude claim blocks new claims until fresh limits settle it after ten minutes", async () => {
  const { redeemReset, loadResetState } = await import("@/lib/gateway/upstreams/reset-redeem");
  const { RETRY_WINDOW_MS } = await import("@/lib/gateway/upstreams/reset-state");
  const account = await addAccount("claude");
  const answers: (() => Response)[] = [
    () => {
      throw new TypeError("socket hang up");
    },
    () => new Response("oops", { status: 503 }),
    () => Response.json({ result: "reset" }),
  ];
  respond(routeClaude(() => answers.shift()!()));
  const start = Date.now();
  assert.equal((await redeemReset(account, { actor: "user-1", trigger: "manual", now: start })).result, "unknown");
  const pending = (await loadResetState(account.id)).pending;
  assert.equal(pending?.grantId, "bonus_2");
  assert.equal(pending?.orgUuid, ORG);
  await assert.rejects(redeemReset(account, { actor: "worker", trigger: "auto", now: start + 60_000 }), /RESET_PENDING/);
  assert.equal(
    (await redeemReset(account, { actor: "user-1", trigger: "manual", now: start + 5 * 60_000 })).result,
    "unknown",
  );
  const [first, retry] = consumes();
  assert.equal(first?.url, `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
  assert.deepEqual(retry?.body, first?.body);
  assert.equal((await loadResetState(account.id)).pending?.attempts, 2);

  const later = start + RETRY_WINDOW_MS + 60_000;
  const outcome = await redeemReset(account, { actor: "user-1", trigger: "manual", now: later });
  assert.equal(outcome.result, "reset");
  const third = consumes()[2];
  assert.notEqual(third?.body?.request_id, first?.body?.request_id);
  assert.deepEqual(auditResults(account.id), ["unknown", "unknown", "expired", "reset"]);
  assert.equal((await loadResetState(account.id)).pending, null);
});

test("the per-account lease lets only one of two concurrent redeems reach the provider", async () => {
  const { redeemReset } = await import("@/lib/gateway/upstreams/reset-redeem");
  const account = await addAccount("codex");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  respond(
    routeCodex(async () => {
      await gate;
      return Response.json({ code: "reset" });
    }),
  );
  const first = redeemReset(account, { actor: "user-1", trigger: "manual" });
  const second = redeemReset(account, { actor: "worker", trigger: "auto" });
  await assert.rejects(second, /RESET_BUSY/);
  release();
  assert.equal((await first).result, "reset");
  assert.equal(consumes().length, 1);
});

test("auto resets redeem a due account once and the 15-minute guard holds the next sweep", async () => {
  const { runAutoResets, loadResetState } = await import("@/lib/gateway/upstreams/reset-redeem");
  const due = await addAccount("codex");
  const calm = await addAccount("codex");
  setPolicy("codex", { scope: "account", percent: 95 });
  respond(routeCodex(() => Response.json({ code: "nothing_to_reset" }), (id) => codexUsage(id === due.id ? 96 : 20)));
  const now = Date.now();
  assert.equal(await runAutoResets(now), 0);
  const [consume] = consumes();
  assert.ok(consume);
  assert.equal(owner(consume), due.id);
  assert.equal((await loadResetState(due.id)).lastAutoAt, now);
  assert.equal(audits.find((row) => row.objectId === due.id)?.actor, "worker");
  await runAutoResets(now + 60_000);
  assert.equal(consumes().length, 1);
  respond(routeCodex(() => Response.json({ code: "reset" }), (id) => codexUsage(id === due.id ? 96 : 20)));
  assert.equal(await runAutoResets(now + 16 * 60_000), 1);
  assert.equal(consumes().length, 2);
  assert.equal(owner(consumes()[1]!), due.id);
  assert.notEqual(consumes()[1]?.body?.redeem_request_id, consume.body?.redeem_request_id);
  assert.deepEqual(auditResults(calm.id), []);
});

test("auto resets skip accounts below the threshold, without an applicable reset, or with the policy off", async () => {
  const { runAutoResets } = await import("@/lib/gateway/upstreams/reset-redeem");
  const account = await addAccount("codex");
  setPolicy("codex", { scope: "account", percent: 99 });
  respond(routeCodex(() => Response.json({ code: "reset" }), () => codexUsage(98)));
  await runAutoResets(Date.now());
  respond(
    routeCodex(
      () => Response.json({ code: "reset" }),
      () => codexUsage(100, { available_count: 3, applicable_available_count: 0 }),
    ),
  );
  const { forgetLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  forgetLimits(account.id);
  snapshotRows.delete(account.id);
  await runAutoResets(Date.now());
  setPolicy("codex", { enabled: false });
  const { forgetAccountPolicies } = await import("@/lib/gateway/routing/account-routing");
  forgetAccountPolicies();
  respond(routeCodex(() => Response.json({ code: "reset" }), () => codexUsage(100)));
  forgetLimits(account.id);
  snapshotRows.delete(account.id);
  await runAutoResets(Date.now());
  assert.equal(consumes().length, 0);
});

test("pool scope waits for every account and spends one reset on the account that waits longest", async () => {
  const { runAutoResets } = await import("@/lib/gateway/upstreams/reset-redeem");
  const { forgetLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const soon = await addAccount("codex");
  const late = await addAccount("codex");
  setPolicy("codex", { scope: "pool", percent: 99 });
  respond(routeCodex(() => Response.json({ code: "reset" }), (id) => codexUsage(id === late.id ? 100 : 50)));
  await runAutoResets(Date.now());
  assert.equal(consumes().length, 0);
  forgetLimits(soon.id);
  forgetLimits(late.id);
  snapshotRows.clear();
  respond(routeCodex(() => Response.json({ code: "reset" }), (id) => codexUsage(100, undefined, id === late.id ? 9_000 : 600)));
  const now = Date.now();
  assert.equal(await runAutoResets(now), 1);
  assert.equal(consumes().length, 1);
  assert.equal(owner(consumes()[0]!), late.id);
  forgetLimits(soon.id);
  forgetLimits(late.id);
  snapshotRows.clear();
  await runAutoResets(now + 60_000);
  assert.equal(consumes().length, 1);
});

test("Claude auto resets wait for the account to be at its limit and then claim next_grant_id", async () => {
  const { autoRedeemIfDue } = await import("@/lib/gateway/upstreams/reset-redeem");
  const notYet = await addAccount("claude");
  const atLimit = await addAccount("claude");
  setPolicy("claude", { scope: "account", percent: 99 });
  respond(routeClaude(() => Response.json({ result: "reset" }), () => claudeBlock(false)));
  assert.deepEqual(await autoRedeemIfDue(notYet.id), { status: "skipped", reason: "not_applicable" });
  assert.equal(consumes().length, 0);
  respond(routeClaude(() => Response.json({ result: "reset" }), () => claudeBlock(true)));
  assert.deepEqual(await autoRedeemIfDue(atLimit.id), { status: "redeemed", providerId: atLimit.id, result: "reset" });
  assert.equal(consumes()[0]?.body?.grant_id, "bonus_2");
  assert.deepEqual(await autoRedeemIfDue(atLimit.id), { status: "skipped", reason: "guard" });
  assert.equal(consumes().length, 1);
});

test("the gateway hook reports why it did nothing", async () => {
  const { autoRedeemIfDue } = await import("@/lib/gateway/upstreams/reset-redeem");
  const off = await addAccount("codex");
  const grok = await addAccount("grok_build");
  respond(routeCodex(() => Response.json({ code: "reset" })));
  assert.deepEqual(await autoRedeemIfDue(off.id), { status: "skipped", reason: "off" });
  assert.deepEqual(await autoRedeemIfDue(grok.id), { status: "skipped", reason: "unsupported" });
  assert.deepEqual(await autoRedeemIfDue(uid("missing")), { status: "skipped", reason: "unsupported" });
  assert.equal(consumes().length, 0);
});

test("reset details on the console show Claude grants, pending claims, and whether a reset can be used", async () => {
  const { withResetDetails, redeemReset } = await import("@/lib/gateway/upstreams/reset-redeem");
  const { fetchSubscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const account = await addAccount("claude");
  respond(routeClaude(() => new Response("", { status: 504 })));
  const limits = await fetchSubscriptionLimits(account);
  assert.equal(limits?.resetCredits, null);
  const detailed = await withResetDetails(account, limits);
  assert.equal(detailed?.resetCredits?.available, 2);
  assert.equal(detailed?.resetCredits?.applicable, 2);
  assert.equal(detailed?.resetCredits?.canRedeem, true);
  assert.deepEqual(
    detailed?.resetCredits?.grants?.map((item) => item.label),
    ["Launch", "Bonus"],
  );
  await redeemReset(account, { actor: "user-1", trigger: "manual" });
  const pending = await withResetDetails(account, limits);
  assert.equal(pending?.resetCredits?.pending?.retryable, true);
  assert.equal(pending?.resetCredits?.canRedeem, true);
  const statusReads = sent.filter((call) => call.url.includes("cedar_ember=1")).length;
  await withResetDetails(account, limits);
  assert.equal(sent.filter((call) => call.url.includes("cedar_ember=1")).length, statusReads);
  const codex = await addAccount("codex");
  respond(routeCodex(() => Response.json({ code: "reset" }), () => codexUsage(100)));
  const codexLimits = await fetchSubscriptionLimits(codex);
  const codexDetails = await withResetDetails(codex, codexLimits);
  assert.equal(codexDetails?.resetCredits?.expiresAt, "2098-01-01T00:00:00.000Z");
  assert.equal(codexDetails?.resetCredits?.canRedeem, true);
  assert.deepEqual(codexLimits?.resetCredits, { available: 1, applicable: 1 });
});

test("only providers:manage can use a reset and only for accounts that bank resets", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { runAction } = await import("@/lib/http/action-result");
  const { redeemProviderReset } = await import("@/lib/providers/resets");
  const codex = await addAccount("codex");
  const grok = await addAccount("grok_build");
  respond(routeCodex(() => Response.json({ code: "reset", windows_reset: 1 })));
  const viewer = principal(["providers:read"]);
  const manager = principal(["providers:read", "providers:manage"]);
  assert.deepEqual(
    await runAsPrincipal(viewer, () => runAction(() => redeemProviderReset({ id: codex.id }))),
    { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" },
  );
  assert.equal(consumes().length, 0);
  assert.deepEqual(
    await runAsPrincipal(manager, () => runAction(() => redeemProviderReset({ id: grok.id }))),
    { ok: false, error: "RESET_UNSUPPORTED", message: "RESET_UNSUPPORTED" },
  );
  const result = await runAsPrincipal(manager, () => redeemProviderReset({ id: codex.id }));
  assert.equal(result.result, "reset");
  assert.equal(result.windowsReset, 1);
  assert.ok(result.limits);
  assert.equal(audits.find((row) => row.objectId === codex.id)?.actor, "user-1");
});

test("auto reset settings are validated, stored per kind, and audited", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { runAction } = await import("@/lib/http/action-result");
  const { loadAccountRouting, saveAutoReset } = await import("@/lib/providers/account-routing");
  const manager = principal(["providers:read", "providers:manage"]);
  for (const input of [
    { kind: "codex" as const, enabled: true, percent: 40, scope: "pool" as const },
    { kind: "codex" as const, enabled: true, percent: 99.5, scope: "pool" as const },
    { kind: "grok_build", enabled: true, percent: 99, scope: "pool" as const },
    { kind: "claude" as const, enabled: true, percent: 99, scope: "everyone" },
  ]) {
    assert.deepEqual(
      await runAsPrincipal(manager, () => runAction(() => saveAutoReset(input as Parameters<typeof saveAutoReset>[0]))),
      { ok: false, error: "VALIDATION", message: "VALIDATION" },
    );
  }
  const saved = await runAsPrincipal(manager, () =>
    saveAutoReset({ kind: "claude", enabled: true, percent: 100, scope: "account" }),
  );
  assert.deepEqual(saved.autoReset, { claude: { enabled: true, percent: 100, scope: "account" } });
  assert.equal(routing.find((row) => row.kind === "claude")?.strategy, "inherit");
  const audit = audits.find((row) => row.action === "account_routing.auto_reset");
  assert.equal(audit?.objectId, "claude");
  const viewer = principal(["providers:read"]);
  const view = await runAsPrincipal(viewer, () => loadAccountRouting());
  assert.equal(view.canManage, false);
  assert.deepEqual(view.autoReset.claude, { enabled: true, percent: 100, scope: "account" });
  assert.deepEqual(
    await runAsPrincipal(viewer, () =>
      runAction(() => saveAutoReset({ kind: "codex", enabled: false, percent: 99, scope: "pool" })),
    ),
    { ok: false, error: "FORBIDDEN", message: "FORBIDDEN" },
  );
});
