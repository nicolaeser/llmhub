import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { openTicket, sealTicket } from "@/lib/gateway/upstreams/subscription-sign-in";
import { SUB_ADD_TOKEN_PATTERN } from "@/lib/http/public-path";
import { completeSignIn, pollSignIn } from "@/lib/providers/connections";
import {
  completeSubAddSignIn,
  loadSubAddContributions,
  openSubAddLink,
  pollSubAddSignIn,
  removeSubAddContribution,
  startSubAddSignIn,
} from "@/lib/providers/sub-add";
import { createSubAddLink, deleteSubAddLink } from "@/lib/providers/sub-add-links";
import { subAddRemaining, subAddStatus } from "@/lib/providers/sub-add-status";
import { newSubAddToken, subAddTokenHash, subAddUid } from "@/lib/providers/sub-add-store";
import { resetRequestWindows } from "@/lib/rate-limit/window";
import { subAddLinkInputSchema } from "@/schemas/sub-add";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { DeviceAuthorization } from "@/types/providers";

const DAY_MS = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;
let fetched: string[] = [];

type LinkFields = {
  id: string;
  label: string;
  kinds: string[];
  expiresAt: Date;
  maxAccounts: number | null;
  added: number;
  restricted: boolean;
  targets: { orgId: string | null; teamId: string | null; projectId: string | null; memberId: string | null; keyId: string | null }[];
};

function link(overrides: Partial<LinkFields> = {}): LinkFields {
  return {
    id: "link-1",
    label: "Friends",
    kinds: ["codex", "claude", "antigravity"],
    expiresAt: new Date(Date.now() + DAY_MS),
    maxAccounts: 1,
    added: 0,
    restricted: false,
    targets: [],
    ...overrides,
  };
}

function linkLookup(token: string, byHash: LinkFields | null, byId: LinkFields | null = byHash) {
  const hash = subAddTokenHash(token);
  return {
    findUnique: (args: { where: { tokenHash?: string; id?: string } }) => {
      if (args.where.tokenHash !== undefined) return args.where.tokenHash === hash ? byHash : null;
      return byId && args.where.id === byId.id ? byId : null;
    },
  };
}

function caller(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "user-1", username: "operator", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function codexDevice(): DeviceAuthorization {
  return {
    grant: { kind: "codex", deviceAuthId: "device-1", userCode: "ABCD-EFGH" },
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    interval: 5,
    expiresIn: 900,
  };
}

function claudeDevice(): DeviceAuthorization {
  return {
    grant: { kind: "claude", verifier: "verifier-1", state: "state-1" },
    verificationUrl: "https://claude.ai/oauth/authorize",
    userCode: "",
    interval: 5,
    expiresIn: 600,
  };
}

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    return handler(url);
  }) as typeof fetch;
}

function isTokenUrl(url: string): boolean {
  const parsed = new URL(url);
  return parsed.hostname === "platform.claude.com" && parsed.pathname === "/v1/oauth/token";
}

function claudeTokens(): Response {
  return Response.json({
    access_token: "sk-ant-oat-access-secret",
    refresh_token: "sk-ant-ort-refresh-secret",
    expires_in: 3600,
    account: { uuid: "acct-1", email_address: "friend@example.com" },
  });
}

let client = 0;

beforeEach(() => {
  fetched = [];
  resetRequestWindows();
  client += 1;
  setRequest({ headers: { "x-forwarded-for": `198.51.100.${client}` } });
  recordedPrisma.reset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  stopLocalCatalogTasks();
});

test("link and manage tokens are 256-bit base64url values kept only as their SHA-256 digest", () => {
  const first = newSubAddToken();
  const second = newSubAddToken();
  assert.match(first.token, SUB_ADD_TOKEN_PATTERN);
  assert.equal(Buffer.from(first.token, "base64url").length, 32);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.hash, second.hash);
  assert.equal(first.hash, createHash("sha256").update(first.token).digest("hex"));
  assert.equal(subAddTokenHash(first.token), first.hash);
  assert.doesNotMatch(first.hash, new RegExp(first.token));
});

test("a link is active until it expires or reaches its account limit", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const base = { expiresAt: new Date(now + 1000), maxAccounts: 2, added: 1 };
  assert.equal(subAddStatus(base, now), "active");
  assert.equal(subAddStatus({ ...base, added: 2 }, now), "used_up");
  assert.equal(subAddStatus({ ...base, maxAccounts: null, added: 500 }, now), "active");
  assert.equal(subAddStatus({ ...base, expiresAt: new Date(now) }, now), "expired");
  assert.equal(subAddStatus({ ...base, expiresAt: new Date(now), added: 2 }, now), "expired");
  assert.equal(subAddRemaining(base), 1);
  assert.equal(subAddRemaining({ ...base, added: 5 }), 0);
  assert.equal(subAddRemaining({ ...base, maxAccounts: null }), null);
});

test("the link form caps expiry at 90 days and accepts an unlimited account count", () => {
  const input = { label: "Team", kinds: ["codex"], days: 7, maxAccounts: null, restricted: false, targets: [] };
  assert.equal(subAddLinkInputSchema.safeParse(input).success, true);
  assert.equal(subAddLinkInputSchema.safeParse({ ...input, days: 91 }).success, false);
  assert.equal(subAddLinkInputSchema.safeParse({ ...input, days: 0 }).success, false);
  assert.equal(subAddLinkInputSchema.safeParse({ ...input, maxAccounts: 0 }).success, false);
  assert.equal(subAddLinkInputSchema.safeParse({ ...input, label: " " }).success, false);
});

test("an open link offers only its kinds that can sign in and looks the token up by digest", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link()) });
  const offer = await openSubAddLink({ token });
  assert.deepEqual(offer.kinds, ["codex", "claude"]);
  assert.equal(offer.label, "Friends");
  assert.equal(offer.remaining, 1);
  const lookups = recordedPrisma.called("subAddLink", "findUnique");
  assert.deepEqual((lookups[0].args as { where: unknown }).where, { tokenHash: subAddTokenHash(token) });
  assert.doesNotMatch(JSON.stringify(recordedPrisma.calls), new RegExp(token));
});

test("unknown, expired, used-up, and malformed links all answer the same neutral code", async () => {
  const { token } = newSubAddToken();
  const cases = [
    null,
    link({ expiresAt: new Date(Date.now() - 1000) }),
    link({ added: 1 }),
    link({ kinds: ["antigravity"] }),
  ];
  for (const row of cases) {
    recordedPrisma.reset({ subAddLink: linkLookup(token, row) });
    await assert.rejects(openSubAddLink({ token }), { message: "SUB_ADD_UNAVAILABLE" });
    await assert.rejects(startSubAddSignIn({ token, kind: "codex" }), { message: "SUB_ADD_UNAVAILABLE" });
  }
  recordedPrisma.reset();
  await assert.rejects(openSubAddLink({ token: "short" }), { message: "SUB_ADD_UNAVAILABLE" });
  assert.deepEqual(recordedPrisma.calls, []);
});

test("starting a sign-in seals a ticket bound to the link and refuses kinds the link does not offer", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link({ kinds: ["claude", "antigravity"] })) });
  const started = await startSubAddSignIn({ token, kind: "claude" });
  assert.equal(started.method, "code");
  assert.notEqual(openTicket(started.ticket, subAddUid("link-1")), null);
  assert.equal(openTicket(started.ticket, "user-1"), null);
  assert.equal(openTicket(started.ticket, subAddUid("link-2")), null);
  await assert.rejects(startSubAddSignIn({ token, kind: "codex" }), { message: "SUB_ADD_UNAVAILABLE" });
  await assert.rejects(startSubAddSignIn({ token, kind: "antigravity" }), { message: "SUB_ADD_UNAVAILABLE" });
  await assert.rejects(startSubAddSignIn({ token, kind: "openai" }), { message: "SUB_ADD_UNAVAILABLE" });
});

test("console tickets and tickets of another link are rejected before any upstream call", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link()) });
  stubFetch(() => Response.json({}));
  for (const uid of ["user-1", subAddUid("link-2")]) {
    await assert.rejects(pollSubAddSignIn({ token, ticket: sealTicket(uid, codexDevice()), interval: 5 }), {
      message: "SIGN_IN_EXPIRED",
    });
    await assert.rejects(
      completeSubAddSignIn({ token, ticket: sealTicket(uid, claudeDevice()), code: "code#state-1" }),
      { message: "SIGN_IN_EXPIRED" },
    );
  }
  assert.deepEqual(fetched, []);
});

test("link tickets are rejected by the console sign-in", async () => {
  stubFetch(() => Response.json({}));
  const manager = caller(["providers:manage"]);
  const codexTicket = sealTicket(subAddUid("link-1"), codexDevice());
  const claudeTicket = sealTicket(subAddUid("link-1"), claudeDevice());
  await assert.rejects(runAsPrincipal(manager, () => pollSignIn({ ticket: codexTicket, interval: 5 })), {
    message: "SIGN_IN_EXPIRED",
  });
  await assert.rejects(runAsPrincipal(manager, () => completeSignIn({ ticket: claudeTicket, code: "code#state-1" })), {
    message: "SIGN_IN_EXPIRED",
  });
  assert.deepEqual(fetched, []);
});

test("a ticket for a kind the link no longer offers is refused", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link({ kinds: ["claude"] })) });
  stubFetch(() => Response.json({}));
  await assert.rejects(
    pollSubAddSignIn({ token, ticket: sealTicket(subAddUid("link-1"), codexDevice()), interval: 5 }),
    { message: "SUB_ADD_UNAVAILABLE" },
  );
  assert.deepEqual(fetched, []);
});

test("a finished sign-in adds a restricted account through the link without leaking tokens", async () => {
  const { token } = newSubAddToken();
  const targets = [{ orgId: "org-1", teamId: null, projectId: null, memberId: null, keyId: null }];
  recordedPrisma.reset({
    subAddLink: linkLookup(token, link({ restricted: true, targets, maxAccounts: 2 })),
    providerConnection: {
      create: (args: { data: Record<string, unknown> }) => ({ id: "provider-1", ...args.data, restricted: true }),
    },
  });
  stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({ account: { has_claude_max: true } })));
  const done = await completeSubAddSignIn({
    token,
    ticket: sealTicket(subAddUid("link-1"), claudeDevice()),
    code: "code-1#state-1",
  });
  assert.equal(done.state, "done");
  if (done.state !== "done") return;
  assert.equal(done.outcome, "created");
  assert.equal(done.account, "friend@example.com");
  assert.match(done.manageToken, SUB_ADD_TOKEN_PATTERN);

  const [created] = recordedPrisma.called("providerConnection", "create");
  const data = (created.args as { data: Record<string, unknown> }).data as {
    kind: string;
    restricted: boolean;
    assignments: { create: unknown };
    subAdd: { create: { linkId: string; label: string; manageHash: string } };
    login: { create: { tokens: string; account: string } };
  };
  assert.equal(data.kind, "claude");
  assert.equal(data.restricted, true);
  assert.deepEqual(data.assignments.create, targets);
  assert.deepEqual(data.subAdd.create, {
    linkId: "link-1",
    label: "Friends",
    manageHash: subAddTokenHash(done.manageToken),
  });
  assert.equal(data.login.create.account, "friend@example.com");
  assert.doesNotMatch(data.login.create.tokens, /secret/);
  assert.deepEqual((recordedPrisma.called("subAddLink", "update")[0].args as { data: unknown }).data, {
    added: { increment: 1 },
  });
  assert.deepEqual(recordedPrisma.called("subAddLink", "delete"), []);

  const [audit] = recordedPrisma.called("gatewayAuditLog", "create");
  const entry = (audit.args as { data: { actor: string; action: string; afterJson: string } }).data;
  assert.equal(entry.actor, "sub-add:link-1");
  assert.equal(entry.action, "provider.sub_add_added");
  assert.doesNotMatch(entry.afterJson, /secret|refresh|access_token/);
  assert.doesNotMatch(entry.afterJson, new RegExp(done.manageToken));
  assert.doesNotMatch(entry.afterJson, new RegExp(token));
});

test("the sign-in that uses up a link deletes it in the same transaction and records why", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({
    subAddLink: linkLookup(token, link({ maxAccounts: 2, added: 1 })),
    providerConnection: { create: (args: { data: object }) => ({ id: "provider-3", ...args.data }) },
  });
  stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({})));
  const done = await completeSubAddSignIn({
    token,
    ticket: sealTicket(subAddUid("link-1"), claudeDevice()),
    code: "code-1#state-1",
  });
  assert.equal(done.state === "done" ? done.outcome : "", "created");
  assert.deepEqual(
    recordedPrisma.calls.filter((call) => call.model === "subAddLink" && call.method !== "findUnique").map((call) => call.method),
    ["update", "delete"],
  );
  const [removed] = recordedPrisma.called("subAddLink", "delete");
  assert.deepEqual((removed.args as { where: unknown }).where, { id: "link-1" });
  const audits = recordedPrisma
    .called("gatewayAuditLog", "create")
    .map((call) => (call.args as { data: { actor: string; action: string; beforeJson: string; afterJson: string } }).data);
  assert.deepEqual(
    audits.map((entry) => [entry.actor, entry.action]),
    [
      ["sub-add:link-1", "provider.sub_add_added"],
      ["sub-add:link-1", "provider_sub_add.delete"],
    ],
  );
  assert.deepEqual(JSON.parse(audits[1].afterJson), { reason: "used_up" });
  assert.equal(JSON.parse(audits[1].beforeJson).added, 2);
  assert.doesNotMatch(audits[1].beforeJson, new RegExp(token));
});

test("the account limit is checked again inside the transaction that adds the account", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link(), link({ added: 1 })) });
  stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({})));
  await assert.rejects(
    completeSubAddSignIn({ token, ticket: sealTicket(subAddUid("link-1"), claudeDevice()), code: "code-1#state-1" }),
    { message: "SUB_ADD_UNAVAILABLE" },
  );
  assert.deepEqual(recordedPrisma.called("providerConnection", "create"), []);
  assert.deepEqual(recordedPrisma.called("subAddLink", "update"), []);
  assert.deepEqual(recordedPrisma.called("subAddLink", "delete"), []);
});

test("an account that is already connected gets the new sign-in without using up the link or changing its owner", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({
    subAddLink: linkLookup(token, link({ maxAccounts: 1, added: 0 })),
    providerConnection: {
      findMany: () => [{ id: "provider-9", login: null }],
      update: (args: { where: { id: string }; data: object }) => ({ id: args.where.id, kind: "claude", ...args.data }),
    },
  });
  stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({})));
  const done = await completeSubAddSignIn({
    token,
    ticket: sealTicket(subAddUid("link-1"), claudeDevice()),
    code: "code-1#state-1",
  });
  assert.equal(done.state === "done" ? done.outcome : "", "updated");
  assert.deepEqual(recordedPrisma.called("providerConnection", "create"), []);
  assert.deepEqual(recordedPrisma.called("subAddLink", "update"), []);
  assert.deepEqual(recordedPrisma.called("subAddLink", "delete"), []);
  const [update] = recordedPrisma.called("providerConnection", "update");
  const args = update.args as { where: { id: string }; data: Record<string, unknown> };
  assert.equal(args.where.id, "provider-9");
  assert.equal(args.data.subAdd, undefined);
  assert.ok(args.data.login);
});

test("a used-up or expired link renews no connection", async () => {
  const { token } = newSubAddToken();
  for (const row of [link({ maxAccounts: 1, added: 1 }), link({ expiresAt: new Date(Date.now() - 1000) })]) {
    recordedPrisma.reset({
      subAddLink: linkLookup(token, link(), row),
      providerConnection: { findMany: () => [{ id: "provider-9", login: null }] },
    });
    stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({})));
    await assert.rejects(
      completeSubAddSignIn({ token, ticket: sealTicket(subAddUid("link-1"), claudeDevice()), code: "code-1#state-1" }),
      { message: "SUB_ADD_UNAVAILABLE" },
    );
    assert.deepEqual(recordedPrisma.called("providerConnection", "update"), []);
    assert.deepEqual(recordedPrisma.called("providerConnection", "create"), []);
  }
});

test("a second account joins the contributor's manage token only when that token was issued", async () => {
  const { token } = newSubAddToken();
  const issued = newSubAddToken();
  const known = new Set([issued.hash]);
  recordedPrisma.reset({
    subAddLink: linkLookup(token, link({ maxAccounts: null })),
    subAddAccount: {
      count: (args: { where: { manageHash: string } }) => (known.has(args.where.manageHash) ? 1 : 0),
    },
    providerConnection: { create: (args: { data: object }) => ({ id: "provider-2", ...args.data }) },
  });
  stubFetch((url) => (isTokenUrl(url) ? claudeTokens() : Response.json({})));
  const ticket = () => sealTicket(subAddUid("link-1"), claudeDevice());
  const joined = await completeSubAddSignIn({ token, ticket: ticket(), code: "c#state-1", manage: issued.token });
  assert.equal(joined.state === "done" ? joined.manageToken : "", issued.token);
  const invented = newSubAddToken().token;
  const fresh = await completeSubAddSignIn({ token, ticket: ticket(), code: "c#state-1", manage: invented });
  assert.equal(fresh.state, "done");
  if (fresh.state !== "done") return;
  assert.notEqual(fresh.manageToken, invented);
  assert.match(fresh.manageToken, SUB_ADD_TOKEN_PATTERN);
});

test("a contributor removes only accounts that belong to their manage token", async () => {
  const manage = newSubAddToken();
  const owned = new Map<string, string | null>([
    ["provider-1", "link-1"],
    ["provider-3", null],
  ]);
  recordedPrisma.reset({
    subAddAccount: {
      findFirst: (args: { where: { providerId: string; manageHash: string } }) =>
        args.where.manageHash === manage.hash && owned.has(args.where.providerId)
          ? { linkId: owned.get(args.where.providerId) }
          : null,
    },
    providerConnection: {
      delete: (args: { where: { id: string } }) => ({ id: args.where.id, name: "Claude", kind: "claude", baseUrl: "" }),
    },
  });
  await assert.rejects(removeSubAddContribution({ manage: manage.token, providerId: "provider-2" }), {
    message: "NOT_FOUND",
  });
  await assert.rejects(removeSubAddContribution({ manage: newSubAddToken().token, providerId: "provider-1" }), {
    message: "NOT_FOUND",
  });
  assert.deepEqual(recordedPrisma.called("providerConnection", "delete"), []);

  const result = await removeSubAddContribution({ manage: manage.token, providerId: "provider-1" });
  assert.deepEqual(result.accounts, []);
  const [deleted] = recordedPrisma.called("providerConnection", "delete");
  assert.deepEqual((deleted.args as { where: unknown }).where, { id: "provider-1" });
  const [audit] = recordedPrisma.called("gatewayAuditLog", "create");
  const entry = (audit.args as { data: { actor: string; action: string; afterJson: string } }).data;
  assert.equal(entry.actor, "sub-add:link-1");
  assert.equal(entry.action, "provider.sub_add_removed");
  assert.doesNotMatch(entry.afterJson, new RegExp(manage.token));
  const listed = recordedPrisma.called("subAddAccount", "findMany").at(-1);
  assert.deepEqual((listed?.args as { where: unknown }).where, { manageHash: manage.hash });

  await removeSubAddContribution({ manage: manage.token, providerId: "provider-3" });
  const orphan = recordedPrisma.called("gatewayAuditLog", "create").at(-1);
  assert.equal((orphan?.args as { data: { actor: string } }).data.actor, "sub-add");
});

test("the manage page lists only the accounts of its token", async () => {
  const manage = newSubAddToken();
  recordedPrisma.reset({
    subAddAccount: {
      findMany: (args: { where: { manageHash: string } }) =>
        args.where.manageHash === manage.hash
          ? [
              {
                providerId: "provider-1",
                createdAt: new Date("2026-10-19T10:00:00Z"),
                provider: { kind: "codex", enabled: true, login: { account: "a@example.com", plan: "plus", status: "active" } },
              },
            ]
          : [],
    },
  });
  const mine = await loadSubAddContributions({ manage: manage.token });
  assert.deepEqual(
    mine.accounts.map((account) => [account.providerId, account.kind, account.account, account.status]),
    [["provider-1", "codex", "a@example.com", "active"]],
  );
  assert.deepEqual((await loadSubAddContributions({ manage: newSubAddToken().token })).accounts, []);
  await assert.rejects(loadSubAddContributions({ manage: "not-a-token" }), { message: "SUB_ADD_UNAVAILABLE" });
});

test("public link endpoints are rate limited per client", async () => {
  const { token } = newSubAddToken();
  recordedPrisma.reset({ subAddLink: linkLookup(token, link()) });
  for (let call = 0; call < 60; call += 1) await openSubAddLink({ token });
  await assert.rejects(openSubAddLink({ token }), { message: "RATE_LIMITED" });
  setRequest({ headers: { "x-forwarded-for": "192.0.2.200" } });
  assert.equal((await openSubAddLink({ token })).label, "Friends");
});

test("creating a link stores only the token digest and returns the link once", async () => {
  recordedPrisma.reset({
    subAddLink: {
      create: (args: { data: Record<string, unknown> }) => ({
        id: "link-9",
        label: args.data.label,
        kinds: args.data.kinds,
        maxAccounts: args.data.maxAccounts,
        added: 0,
        restricted: args.data.restricted,
        expiresAt: args.data.expiresAt,
        createdAt: new Date(),
        createdById: args.data.createdById,
        targets: [],
        accounts: [],
      }),
    },
  });
  const created = await runAsPrincipal(caller(["providers:manage"]), () =>
    createSubAddLink({ label: "Team", kinds: ["codex", "claude", "codex"], days: 7, maxAccounts: 3, restricted: false, targets: [] }),
  );
  const token = created.url.split("/providers/sub-add/")[1];
  assert.match(token, SUB_ADD_TOKEN_PATTERN);
  const [insert] = recordedPrisma.called("subAddLink", "create");
  const data = (insert.args as { data: Record<string, unknown> }).data;
  assert.equal(data.tokenHash, subAddTokenHash(token));
  assert.deepEqual(data.kinds, ["codex", "claude"]);
  assert.equal(data.createdById, "user-1");
  assert.doesNotMatch(JSON.stringify(recordedPrisma.calls), new RegExp(token));
  assert.equal(created.link.maxAccounts, 3);
  const [audit] = recordedPrisma.called("gatewayAuditLog", "create");
  assert.equal((audit.args as { data: { action: string } }).data.action, "provider_sub_add.create");
});

test("link management needs providers:manage and validates kinds, expiry, and targets", async () => {
  const input = { label: "Team", kinds: ["codex"], days: 7, maxAccounts: 1, restricted: false, targets: [] };
  await assert.rejects(runAsPrincipal(caller(["providers:read"]), () => createSubAddLink(input)), {
    message: "FORBIDDEN",
  });
  await assert.rejects(runAsPrincipal(caller(["providers:read"]), () => deleteSubAddLink("link-1")), {
    message: "FORBIDDEN",
  });
  const manager = caller(["providers:manage"]);
  await assert.rejects(runAsPrincipal(manager, () => createSubAddLink({ ...input, kinds: ["openai"] })), {
    message: "UNKNOWN_PROVIDER_KIND",
  });
  await assert.rejects(runAsPrincipal(manager, () => createSubAddLink({ ...input, days: 120 })), {
    message: "VALIDATION",
  });
  await assert.rejects(
    runAsPrincipal(manager, () =>
      createSubAddLink({ ...input, restricted: true, targets: [{ scope: "org", id: "missing" }] }),
    ),
    { message: "NOT_FOUND" },
  );
  assert.deepEqual(recordedPrisma.called("subAddLink", "create"), []);
});

test("revoking a link deletes it once and writes one audit row with the reason", async () => {
  let stored: Record<string, unknown> | null = {
    id: "link-1",
    label: "Friends",
    kinds: ["codex"],
    maxAccounts: 1,
    added: 0,
    restricted: false,
    expiresAt: new Date(Date.now() + DAY_MS),
    createdAt: new Date(),
    createdById: "user-1",
    targets: [],
    accounts: [],
  };
  recordedPrisma.reset({
    subAddLink: {
      findUnique: () => (stored ? { ...stored } : null),
      deleteMany: () => {
        const count = stored ? 1 : 0;
        stored = null;
        return { count };
      },
    },
  });
  const manager = caller(["providers:manage"]);
  assert.deepEqual(await runAsPrincipal(manager, () => deleteSubAddLink("link-1")), { id: "link-1" });
  await assert.rejects(runAsPrincipal(manager, () => deleteSubAddLink("link-1")), { message: "NOT_FOUND" });
  assert.equal(recordedPrisma.called("subAddLink", "deleteMany").length, 1);
  const audits = recordedPrisma.called("gatewayAuditLog", "create");
  assert.equal(audits.length, 1);
  const entry = (audits[0].args as { data: { action: string; beforeJson: string; afterJson: string } }).data;
  assert.equal(entry.action, "provider_sub_add.delete");
  assert.equal(JSON.parse(entry.beforeJson).label, "Friends");
  assert.deepEqual(JSON.parse(entry.afterJson), { reason: "revoked" });
});
