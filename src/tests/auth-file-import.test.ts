import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

type FakeLogin = {
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  leaseUntil: Date | null;
};

type FakeConnection = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  discovered: unknown[];
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
  enabled: boolean;
  restricted: boolean;
  login: FakeLogin | null;
};

type LoginWrite = Omit<FakeLogin, "version">;

const connections: FakeConnection[] = [];
const audits: { action: string; objectId: string; afterJson: string }[] = [];
const settings = new Map<string, string>();

function view(row: FakeConnection) {
  return {
    ...row,
    assignments: [],
    login: row.login ? { account: row.login.account, plan: row.login.plan, status: row.login.status } : null,
  };
}

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
  },
  providerConnection: {
    findMany: async ({
      where,
    }: {
      where: { kind: string; login: { is: { account: { equals: string } } } };
    }) =>
      connections
        .filter(
          (row) =>
            row.kind === where.kind &&
            row.login?.account.toLowerCase() === where.login.is.account.equals.toLowerCase(),
        )
        .map((row) => ({ id: row.id, login: row.login ? { tokens: row.login.tokens } : null })),
    create: async ({
      data,
    }: {
      data: { name: string; kind: string; baseUrl: string; apiKey: string; login: { create: LoginWrite } };
    }) => {
      const row: FakeConnection = {
        id: `p${connections.length + 1}`,
        name: data.name,
        kind: data.kind,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        discovered: [],
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
        enabled: true,
        restricted: false,
        login: { ...data.login.create, version: 0 },
      };
      connections.push(row);
      return view(row);
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { baseUrl?: string; login: { upsert: { create: LoginWrite; update: LoginWrite & { version: { increment: number } } } } };
    }) => {
      const row = connections.find((item) => item.id === where.id)!;
      if (data.baseUrl) row.baseUrl = data.baseUrl;
      const { version, ...rest } = data.login.upsert.update;
      row.login = row.login
        ? { ...row.login, ...rest, version: row.login.version + version.increment }
        : { ...data.login.upsert.create, version: 0 };
      return view(row);
    },
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: { action: string; objectId: string; afterJson: string } }) => {
      audits.push(data);
      return data;
    },
  },
};

const realFetch = globalThis.fetch;
let calls: { url: string; body: string }[] = [];

function respondWith(handler: (url: string, body: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
}

function refuseNetwork() {
  respondWith((url) => {
    throw new Error(`unexpected request to ${url}`);
  });
}

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

const HOUR_S = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function codexIdToken(accountId: string, email = "dev@example.com", plan = "plus") {
  return jwt({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
  });
}

function codexFile(overrides: Record<string, unknown> = {}) {
  return {
    type: "codex",
    id_token: codexIdToken("acct_file"),
    access_token: jwt({ exp: nowSeconds() + HOUR_S }),
    refresh_token: "rt_codex",
    account_id: "acct_file",
    email: "dev@example.com",
    plan_type: "plus",
    last_refresh: "2026-10-19T10:00:00Z",
    expired: "2026-10-29T10:00:00Z",
    ...overrides,
  };
}

function caller(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "operator", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

async function asCaller<T>(fn: () => Promise<T>, permissions: Permission[] = ["providers:manage"]): Promise<T> {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  return runAsPrincipal(caller(permissions), fn);
}

function scheduledTasks(): string[] {
  return [...((globalThis as GlobalWithWorkerBoot).__llmhubCatalogTimers?.keys() ?? [])];
}

beforeEach(() => {
  calls = [];
  connections.length = 0;
  audits.length = 0;
  settings.clear();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { stopLocalCatalogTasks } = await import("@/lib/gateway/catalog/catalog-tasks");
  stopLocalCatalogTasks();
});

test("codex files keep their account, plan, and the access token expiry", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const exp = nowSeconds() + HOUR_S;
  const file = codexFile({ access_token: jwt({ exp }) });
  const parsed = parseAuthFileEntry(file);
  assert.equal(parsed.kind, "codex");
  assert.equal(parsed.needsProject, false);
  assert.deepEqual(parsed.session, {
    tokens: { access: file.access_token, refresh: "rt_codex", accountId: "acct_file", residency: "" },
    expiresAt: exp * 1000,
    account: "dev@example.com",
    plan: "plus",
  });
});

test("codex files without account_id derive the workspace, plan, and email from the JWT claims", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const fromId = parseAuthFileEntry(
    codexFile({ account_id: undefined, email: undefined, plan_type: undefined, id_token: codexIdToken("acct_jwt", "jwt@example.com", "pro") }),
  );
  assert.equal(fromId.session.tokens.accountId, "acct_jwt");
  assert.equal(fromId.session.account, "jwt@example.com");
  assert.equal(fromId.session.plan, "pro");
  const fromAccess = parseAuthFileEntry(
    codexFile({
      account_id: "",
      id_token: "",
      access_token: jwt({ exp: nowSeconds() + HOUR_S, "https://api.openai.com/auth": { chatgpt_account_id: "acct_access" } }),
    }),
  );
  assert.equal(fromAccess.session.tokens.accountId, "acct_access");
  assert.throws(() => parseAuthFileEntry(codexFile({ account_id: "", id_token: "" })), { message: "AUTH_FILE_INCOMPLETE" });
});

test("claude files accept camelCase refresh tokens and store the account uuid", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const parsed = parseAuthFileEntry({
    type: "claude",
    id_token: "",
    access_token: "sk-ant-oat01-access",
    refreshToken: "sk-ant-ort01-refresh",
    email: "claude@example.com",
    account_uuid: "uuid-1",
    organization_uuid: "org-1",
    expired: "2026-10-19T14:30:00+02:00",
  });
  assert.equal(parsed.kind, "claude");
  assert.deepEqual(parsed.session, {
    tokens: { access: "sk-ant-oat01-access", refresh: "sk-ant-ort01-refresh", accountId: "uuid-1", residency: "" },
    expiresAt: Date.parse("2026-10-19T12:30:00Z"),
    account: "claude@example.com",
    plan: "",
  });
  assert.equal(parseAuthFileEntry({ type: "Anthropic", access_token: "a", refresh_token: "r" }).kind, "claude");
});

test("antigravity files use expires_in with the millisecond timestamp and keep the Cloud project", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const timestamp = Date.parse("2026-10-19T10:00:00Z");
  const parsed = parseAuthFileEntry({
    type: "antigravity",
    access_token: "ya29.access",
    refresh_token: "1//refresh",
    expires_in: 3599,
    timestamp,
    email: "g@example.com",
    project_id: "proj-1",
  });
  assert.equal(parsed.kind, "antigravity");
  assert.equal(parsed.needsProject, false);
  assert.equal(parsed.session.expiresAt, timestamp + 3_599_000);
  assert.equal(parsed.session.tokens.accountId, "proj-1");
  assert.equal(parsed.session.account, "g@example.com");
  const withoutProject = parseAuthFileEntry({ type: "anti-gravity", access_token: "a", refresh_token: "r" });
  assert.equal(withoutProject.kind, "antigravity");
  assert.equal(withoutProject.needsProject, true);
  assert.equal(withoutProject.session.expiresAt, 0);
});

test("xai files become Grok Build accounts", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const parsed = parseAuthFileEntry({
    type: "xai",
    access_token: "xai-access",
    refresh_token: "xai-refresh",
    token_type: "Bearer",
    expired: "2026-10-19T12:00:00Z",
    email: "grok@example.com",
    sub: "user-1",
    base_url: "https://api.x.ai/v1",
    auth_kind: "oauth",
  });
  assert.equal(parsed.kind, "grok_build");
  assert.equal(parsed.session.account, "grok@example.com");
  assert.equal(parsed.session.expiresAt, Date.parse("2026-10-19T12:00:00Z"));
  assert.deepEqual(parsed.session.tokens, { access: "xai-access", refresh: "xai-refresh", accountId: "", residency: "" });
});

test("expiry values parse RFC 3339, plain times, unix seconds, and milliseconds", async () => {
  const { authFileExpiry, authFileInstant } = await import("@/lib/gateway/upstreams/auth-file-import");
  const at = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(authFileInstant("2026-10-19T14:00:00+02:00"), at);
  assert.equal(authFileInstant("2026-10-19T12:00:00.123456789Z"), at + 123);
  assert.equal(authFileInstant("2026-10-19 12:00:00"), at);
  assert.equal(authFileInstant("2026-10-19 12:00"), at);
  assert.equal(authFileInstant(at / 1000), at);
  assert.equal(authFileInstant(String(at / 1000)), at);
  assert.equal(authFileInstant(at), at);
  assert.equal(authFileInstant("0001-01-01T00:00:00Z"), null);
  assert.equal(authFileInstant("tomorrow"), null);
  assert.equal(authFileInstant(true), null);
  assert.equal(authFileExpiry({ expires_at: at / 1000 }, "opaque"), at);
  assert.equal(authFileExpiry({ expiresIn: 60, issuedAt: at }, "opaque"), at + 60_000);
  assert.equal(authFileExpiry({ token: { expiry: "2026-10-19T12:00:00Z" } }, "opaque"), at);
  assert.equal(authFileExpiry({ expires_in: 60 }, "opaque"), null);
  const exp = nowSeconds() + HOUR_S;
  assert.equal(authFileExpiry({ expired: "2026-10-19T12:00:00Z" }, jwt({ exp })), exp * 1000);
});

test("files may hold one account, an array of accounts, or a wrapper around them", async () => {
  const { authFileEntries, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  assert.equal(authFileEntries(JSON.stringify(codexFile())).length, 1);
  const list = authFileEntries(
    JSON.stringify([codexFile(), { type: "xai", access_token: "a", refresh_token: "r" }]),
  );
  assert.deepEqual(list.map((entry) => parseAuthFileEntry(entry).kind), ["codex", "grok_build"]);
  const wrapped = authFileEntries(JSON.stringify({ accounts: [codexFile(), codexFile({ email: "b@example.com" })] }));
  assert.equal(wrapped.length, 2);
  assert.throws(() => authFileEntries("not json"), { message: "AUTH_FILE_INVALID" });
  assert.throws(() => authFileEntries("[]"), { message: "AUTH_FILE_INVALID" });
  assert.throws(() => authFileEntries('"codex"'), { message: "AUTH_FILE_INVALID" });
  assert.throws(() => parseAuthFileEntry(42), { message: "AUTH_FILE_INVALID" });
});

test("unsupported providers and SIWC Codex clients are rejected", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  for (const type of ["kimi", "gemini", "gemini-cli", "vertex", "qwen", "iflow", "constructor", ""]) {
    assert.throws(() => parseAuthFileEntry({ type, access_token: "a", refresh_token: "r" }), {
      message: "AUTH_FILE_UNSUPPORTED",
    });
  }
  assert.throws(() => parseAuthFileEntry({ access_token: "a", refresh_token: "r" }), { message: "AUTH_FILE_UNSUPPORTED" });
  assert.throws(() => parseAuthFileEntry(codexFile({ use_siwc: true, siwc: { client_id: "x" } })), {
    message: "AUTH_FILE_UNSUPPORTED",
  });
  assert.equal(parseAuthFileEntry(codexFile({ use_siwc: false })).kind, "codex");
});

test("files without an access or refresh token are incomplete", async () => {
  const { parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  assert.throws(() => parseAuthFileEntry(codexFile({ refresh_token: "" })), { message: "AUTH_FILE_INCOMPLETE" });
  assert.throws(() => parseAuthFileEntry({ type: "claude", refresh_token: "r" }), { message: "AUTH_FILE_INCOMPLETE" });
  assert.throws(() => parseAuthFileEntry({ type: "xai", access_token: "a" }), { message: "AUTH_FILE_INCOMPLETE" });
});

test("the sign-in dialog picks the account of its own kind", async () => {
  const { authFileEntryFor } = await import("@/lib/gateway/upstreams/auth-file-import");
  const claude = { type: "claude", access_token: "a", refresh_token: "r" };
  assert.equal(authFileEntryFor([codexFile(), claude], "claude"), claude);
  assert.throws(() => authFileEntryFor([codexFile()], "claude"), { message: "AUTH_FILE_KIND_MISMATCH" });
  const kimi = { type: "kimi" };
  assert.equal(authFileEntryFor([kimi], "claude"), kimi);
});

test("fresh tokens are imported without refreshing", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  refuseNetwork();
  const parsed = parseAuthFileEntry(codexFile());
  assert.deepEqual(await freshAuthFileSession(parsed), parsed.session);
  assert.equal(calls.length, 0);
});

test("expiring tokens refresh with the hub client and keep the file's account", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const exp = nowSeconds() + HOUR_S;
  respondWith(() => Response.json({ access_token: jwt({ exp }), refresh_token: "rt_rotated" }));
  const parsed = parseAuthFileEntry(codexFile({ access_token: jwt({ exp: nowSeconds() + 60 }) }));
  const session = await freshAuthFileSession(parsed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://auth.openai.com/oauth/token");
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: "rt_codex",
  });
  assert.equal(session.tokens.access, jwt({ exp }));
  assert.equal(session.tokens.refresh, "rt_rotated");
  assert.equal(session.tokens.accountId, "acct_file");
  assert.equal(session.account, "dev@example.com");
  assert.equal(session.expiresAt, exp * 1000);
});

test("a revoked refresh token fails as expired and a transient failure as upstream failure", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const stale = parseAuthFileEntry({ type: "xai", access_token: "a", refresh_token: "r", expired: "2020-01-01T00:00:00Z" });
  respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(freshAuthFileSession(stale), { message: "AUTH_FILE_EXPIRED" });
  respondWith(() => new Response("bad gateway", { status: 502 }));
  await assert.rejects(freshAuthFileSession(stale), { message: "UPSTREAM_FAILED" });
});

test("claude imports look up the plan from the profile", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  respondWith(() => Response.json({ account: {}, organization: { rate_limit_tier: "default_claude_max_20x" } }));
  const parsed = parseAuthFileEntry({
    type: "claude",
    access_token: "sk-ant-oat01-access",
    refresh_token: "r",
    email: "claude@example.com",
    expired: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const session = await freshAuthFileSession(parsed);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/api/oauth/profile");
  assert.equal(session.plan, "max_20x");
});

test("antigravity imports need the client secret and fill the project and plan", async () => {
  const { freshAuthFileSession, parseAuthFileEntry } = await import("@/lib/gateway/upstreams/auth-file-import");
  const parsed = parseAuthFileEntry({
    type: "antigravity",
    access_token: "ya29.access",
    refresh_token: "1//refresh",
    email: "g@example.com",
    expired: new Date(Date.now() + 3_600_000).toISOString(),
  });
  refuseNetwork();
  await assert.rejects(freshAuthFileSession(parsed), { message: "ANTIGRAVITY_NOT_CONFIGURED" });
  settings.set("enterprise", JSON.stringify({ antigravity: { client_secret: "secret" } }));
  respondWith(() => Response.json({ cloudaicompanionProject: "proj-9", paidTier: { id: "g1-pro-tier" } }));
  const session = await freshAuthFileSession(parsed);
  assert.ok(calls[0]!.url.endsWith(":loadCodeAssist"));
  assert.equal(session.tokens.accountId, "proj-9");
  assert.equal(session.plan, "pro");
  assert.equal(session.account, "g@example.com");
});

test("bulk import creates accounts, updates known ones, and isolates bad files", async () => {
  const { importAuthFiles } = await import("@/lib/providers/auth-import");
  refuseNetwork();
  const first = await asCaller(() =>
    importAuthFiles([
      { name: "codex-dev.json", content: JSON.stringify(codexFile()) },
      { name: "kimi.json", content: JSON.stringify({ type: "kimi", access_token: "a", refresh_token: "r" }) },
      { name: "broken.json", content: "{" },
    ]),
  );
  assert.deepEqual(first.results, [
    { file: "codex-dev.json", kind: "codex", account: "dev@example.com", plan: "plus", status: "created" },
    { file: "kimi.json", status: "failed", error: "AUTH_FILE_UNSUPPORTED" },
    { file: "broken.json", status: "failed", error: "AUTH_FILE_INVALID" },
  ]);
  assert.equal(first.providers.length, 1);
  assert.equal(first.providers[0]!.kind, "codex");
  assert.equal(first.providers[0]!.name, "ChatGPT subscription (Codex)");
  assert.equal(first.providers[0]!.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.deepEqual(first.providers[0]!.signIn, { account: "dev@example.com", plan: "plus", status: "active" });
  assert.deepEqual(scheduledTasks().length, 1);

  connections[0]!.login!.status = "expired";
  connections[0]!.login!.leaseUntil = new Date();
  const second = await asCaller(() =>
    importAuthFiles([
      { name: "again.json", content: JSON.stringify(codexFile({ email: "DEV@example.com", refresh_token: "rt_new" })) },
      { name: "other-workspace.json", content: JSON.stringify(codexFile({ account_id: "acct_team" })) },
    ]),
  );
  assert.deepEqual(
    second.results.map((item) => item.status),
    ["updated", "created"],
  );
  assert.equal(connections.length, 2);
  const login = connections[0]!.login!;
  assert.equal(login.version, 1);
  assert.equal(login.status, "active");
  assert.equal(login.leaseUntil, null);
  assert.equal(login.account, "DEV@example.com");
  assert.equal(audits.length, 3);
  assert.ok(audits.every((row) => row.action === "provider.import_auth_file"));
  assert.ok(audits.every((row) => !/rt_codex|rt_new|eyJ/.test(row.afterJson)));
  assert.ok(connections.every((row) => !row.login!.tokens.includes("rt_")));
});

test("bulk import needs providers:manage and validates the upload", async () => {
  const { importAuthFiles } = await import("@/lib/providers/auth-import");
  await assert.rejects(
    asCaller(() => importAuthFiles([{ name: "a.json", content: "{}" }]), ["providers:read"]),
    { message: "FORBIDDEN" },
  );
  await assert.rejects(asCaller(() => importAuthFiles([])), { message: "VALIDATION" });
  await assert.rejects(
    asCaller(() => importAuthFiles([{ name: "big.json", content: "x".repeat(256 * 1024 + 1) }])),
    { message: "VALIDATION" },
  );
  assert.equal(connections.length, 0);
});

test("single file import returns a sealed credential for the dialog", async () => {
  const { importSignInFile } = await import("@/lib/providers/auth-import");
  const { openCredential } = await import("@/lib/gateway/upstreams/subscription-sign-in");
  refuseNetwork();
  const result = await asCaller(() => importSignInFile("codex", JSON.stringify([codexFile()])));
  assert.equal(result.account, "dev@example.com");
  assert.equal(result.plan, "plus");
  assert.equal(result.credential.includes("rt_codex"), false);
  assert.equal(openCredential(result.credential, "u1", "codex")?.session.tokens.refresh, "rt_codex");
  await assert.rejects(asCaller(() => importSignInFile("claude", JSON.stringify(codexFile()))), {
    message: "AUTH_FILE_KIND_MISMATCH",
  });
  assert.equal(connections.length, 0);
});
