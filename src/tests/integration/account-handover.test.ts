import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { isRouterError } from "@/lib/gateway/core";
import { stopLocalCatalogTasks } from "@/lib/gateway/catalog/catalog-tasks";
import { readPin, writePin } from "@/lib/gateway/routing/account-affinity";
import { coolingDown } from "@/lib/gateway/routing/provider-health";
import { acquireGroup, loadGroup, markFailure } from "@/lib/gateway/routing/runtime";
import { loginData, openTokens, providerAuth } from "@/lib/gateway/upstreams/credentials";
import { sealCredential } from "@/lib/gateway/upstreams/subscription-sign-in";
import { importUploads } from "@/lib/providers/auth-import";
import { createProvider, updateProvider } from "@/lib/providers/connections";
import { newSubAddToken, storeSubAddAccount } from "@/lib/providers/sub-add-store";
import type { ResolvedDeployment } from "@/types/routing";
import type { AccountAccess, SignInSession } from "@/types/providers";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const HOUR_MS = 3_600_000;

let tokenReply: () => Promise<Response> = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
const tokenCalls: number[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === CLAUDE_TOKEN_URL) {
    tokenCalls.push(Date.now());
    return tokenReply();
  }
  return Response.json({ account: { has_claude_max: true }, organization: {} });
}) as typeof fetch;

function session(account: string, accountId: string, access: string, expiresAt = Date.now() + 8 * HOUR_MS): SignInSession {
  return { tokens: { access, refresh: `${access}-refresh`, accountId, residency: "" }, expiresAt, account, plan: "max" };
}

async function claudeAccount(input: {
  account: string;
  access: string;
  expiresAt?: number;
  login?: Record<string, unknown>;
  connection?: Record<string, unknown>;
}) {
  const alias = uniqueName("claude-route");
  const provider = await prisma.providerConnection.create({
    data: {
      name: uniqueName("claude"),
      kind: "claude",
      ...input.connection,
      login: { create: { ...loginData(session(input.account, "id-1", input.access, input.expiresAt)), ...input.login } },
    },
  });
  const group = await prisma.modelGroup.create({
    data: { alias, deployments: { create: [{ kind: "claude", providerId: provider.id, model: "claude-test" }] } },
    include: { deployments: true },
  });
  return { provider, alias, route: group.deployments[0]!.id };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

async function cleanup(owner: { user: { id: string } }, providers: string[], aliases: string[]) {
  stopLocalCatalogTasks();
  await prisma.modelGroup.deleteMany({ where: { alias: { in: aliases } } });
  await prisma.providerConnection.deleteMany({ where: { id: { in: providers } } });
  await prisma.user.deleteMany({ where: { id: owner.user.id } });
}

test("signing in to the same Claude account again keeps its connection, routes, assignments, and pins and clears its marks", async () => {
  const owner = await ownerSession();
  const org = await prisma.organization.create({ data: { alias: uniqueName("org") } });
  const account = `${uniqueName("renew")}@example.test`;
  const { provider, alias, route } = await claudeAccount({
    account,
    access: "old-access",
    login: { failures: 3, retryAt: new Date(Date.now() + 10 * 60_000) },
    connection: { restricted: true, assignments: { create: [{ orgId: org.id }] } },
  });
  const access: AccountAccess = { orgId: org.id, teamId: "", projectId: "", memberId: "", keyId: "" };
  try {
    markFailure({ id: route } as ResolvedDeployment, Date.now() + 3 * HOUR_MS);
    assert.ok((await coolingDown([route])).has(route));
    await writePin("claude", "renewed-run", { providerId: provider.id, handoffAt: 0 }, null);

    const signIn = sealCredential(owner.user.id, "claude", session(account.toUpperCase(), "id-1", "new-access"));
    const result = await runAsPrincipal(owner, () =>
      createProvider({ name: "", kind: "claude", baseUrl: "", apiKey: "", signIn }),
    );
    stopLocalCatalogTasks();

    assert.equal(result.outcome, "updated");
    assert.equal(result.provider.id, provider.id);
    assert.equal(result.provider.signIn?.status, "active");
    const login = await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: provider.id } });
    assert.equal(login.version, 1);
    assert.equal(login.failures, 0);
    assert.equal(login.retryAt, null);
    assert.equal(openTokens(login.tokens, provider.id).access, "new-access");
    assert.equal(await prisma.deployment.count({ where: { id: route, providerId: provider.id } }), 1);
    assert.equal(await prisma.providerAssignment.count({ where: { providerId: provider.id, orgId: org.id } }), 1);
    assert.equal((await coolingDown([route])).size, 0);
    assert.deepEqual(await readPin("claude", "renewed-run"), { providerId: provider.id, handoffAt: 0 });
    const acquired = await acquireGroup(await loadGroup(alias), undefined, undefined, "", undefined, access);
    acquired.release();
    assert.equal(acquired.dep.id, route);
    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({ where: { action: "provider.connect", objectId: provider.id } });
    assert.equal(JSON.parse(audit.afterJson).outcome, "updated");
    assert.doesNotMatch(audit.afterJson, /new-access|old-access/);
  } finally {
    await cleanup(owner, [provider.id], [alias]);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test("pausing and resuming an account is audited and the resume clears its marks without touching the token version", async () => {
  const owner = await ownerSession();
  const { provider, alias, route } = await claudeAccount({
    account: `${uniqueName("pause")}@example.test`,
    access: "steady-access",
    login: { version: 3 },
  });
  const toggle = (enabled: boolean) =>
    runAsPrincipal(owner, () => updateProvider({ id: provider.id, name: "", baseUrl: "", apiKey: "", enabled }));
  try {
    assert.equal((await toggle(false)).provider.enabled, false);
    const paused = await prisma.gatewayAuditLog.findFirstOrThrow({ where: { action: "provider.pause", objectId: provider.id } });
    assert.deepEqual(JSON.parse(paused.beforeJson), { enabled: true, internal: false });
    assert.equal(JSON.parse(paused.afterJson).enabled, false);
    await assert.rejects(acquireGroup(await loadGroup(alias), undefined), (err: unknown) => isRouterError(err, "all_paused"));

    markFailure({ id: route } as ResolvedDeployment, Date.now() + HOUR_MS);
    await prisma.providerLogin.update({
      where: { providerId: provider.id },
      data: { failures: 2, retryAt: new Date(Date.now() + 20 * 60_000) },
    });

    assert.equal((await toggle(true)).provider.enabled, true);
    const resumed = await prisma.gatewayAuditLog.findFirstOrThrow({ where: { action: "provider.resume", objectId: provider.id } });
    assert.deepEqual(JSON.parse(resumed.beforeJson), { enabled: false, internal: false });
    assert.equal((await coolingDown([route])).size, 0);
    const login = await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: provider.id } });
    assert.equal(login.failures, 0);
    assert.equal(login.retryAt, null);
    assert.equal(login.version, 3);
    assert.equal(openTokens(login.tokens, provider.id).access, "steady-access");
    const acquired = await acquireGroup(await loadGroup(alias), undefined);
    acquired.release();
    assert.equal(acquired.dep.id, route);
  } finally {
    await cleanup(owner, [provider.id], [alias]);
  }
});

test("routing reads the sign-in state with the routes and skips an expired account", async () => {
  const owner = await ownerSession();
  const live = await claudeAccount({ account: `${uniqueName("live")}@example.test`, access: "live-access" });
  const expired = await claudeAccount({
    account: `${uniqueName("expired")}@example.test`,
    access: "dead-access",
    login: { status: "expired" },
  });
  try {
    await prisma.deployment.updateMany({ where: { id: expired.route }, data: { groupAlias: live.alias, weight: 100 } });
    const group = await loadGroup(live.alias);
    assert.equal(group.mapped.length, 2);
    const acquired = await acquireGroup(group, undefined);
    acquired.release();
    assert.equal(acquired.dep.id, live.route);
    await prisma.providerLogin.update({ where: { providerId: live.provider.id }, data: { status: "expired" } });
    await assert.rejects(acquireGroup(await loadGroup(live.alias), undefined), (err: unknown) => isRouterError(err, "signed_out"));
  } finally {
    await cleanup(owner, [live.provider.id, expired.provider.id], [live.alias, expired.alias]);
  }
});

test("a token refresh that finishes after a new sign-in cannot overwrite the new tokens", async () => {
  const owner = await ownerSession();
  const account = `${uniqueName("race")}@example.test`;
  const { provider, alias } = await claudeAccount({ account, access: "expiring-access", expiresAt: Date.now() + 2 * 60_000 });
  let answer: (res: Response) => void = () => {};
  tokenCalls.length = 0;
  tokenReply = () => new Promise<Response>((resolve) => (answer = resolve));
  try {
    const pending = providerAuth({ id: provider.id, kind: "claude", apiKey: "" });
    await waitFor(() => tokenCalls.length === 1);
    const signIn = sealCredential(owner.user.id, "claude", session(account, "id-1", "signed-in-access"));
    await runAsPrincipal(owner, () => createProvider({ name: "", kind: "claude", baseUrl: "", apiKey: "", signIn }));
    answer(
      Response.json({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 28_800,
        account: { email_address: account, uuid: "id-1" },
      }),
    );
    assert.equal((await pending).key, "signed-in-access");
    const login = await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: provider.id } });
    assert.equal(openTokens(login.tokens, provider.id).access, "signed-in-access");
    assert.equal(login.version, 1);
    assert.equal(login.status, "active");
    assert.equal(login.leaseUntil, null);
  } finally {
    await cleanup(owner, [provider.id], [alias]);
  }
});

test("a fatal refresh answer that arrives after a new sign-in leaves the renewed login active", async () => {
  const owner = await ownerSession();
  const account = `${uniqueName("fatal")}@example.test`;
  const { provider, alias } = await claudeAccount({ account, access: "dead-access", expiresAt: Date.now() - 60_000 });
  let answer: (res: Response) => void = () => {};
  tokenCalls.length = 0;
  tokenReply = () => new Promise<Response>((resolve) => (answer = resolve));
  try {
    const pending = providerAuth({ id: provider.id, kind: "claude", apiKey: "" });
    await waitFor(() => tokenCalls.length === 1);
    const signIn = sealCredential(owner.user.id, "claude", session(account, "id-1", "revived-access"));
    await runAsPrincipal(owner, () => createProvider({ name: "", kind: "claude", baseUrl: "", apiKey: "", signIn }));
    answer(Response.json({ error: "invalid_grant" }, { status: 400 }));
    assert.equal((await pending).key, "revived-access");
    const login = await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: provider.id } });
    assert.equal(login.status, "active");
    assert.equal(openTokens(login.tokens, provider.id).access, "revived-access");
    assert.equal(login.failures, 0);
  } finally {
    await cleanup(owner, [provider.id], [alias]);
  }
});

test("renewing an account through an add-account link or an auth-file import clears its marks", async () => {
  const owner = await ownerSession();
  const linked = await claudeAccount({ account: `${uniqueName("linked")}@example.test`, access: "linked-old" });
  const imported = await claudeAccount({ account: `${uniqueName("imported")}@example.test`, access: "imported-old" });
  const link = await prisma.subAddLink.create({
    data: {
      label: uniqueName("link"),
      tokenHash: newSubAddToken().hash,
      kinds: ["claude"],
      maxAccounts: 2,
      expiresAt: new Date(Date.now() + 24 * HOUR_MS),
    },
  });
  try {
    for (const route of [linked.route, imported.route]) markFailure({ id: route } as ResolvedDeployment, Date.now() + 2 * HOUR_MS);
    const linkedAccount = (await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: linked.provider.id } })).account;
    const stored = await storeSubAddAccount({
      linkId: link.id,
      kind: "claude",
      session: session(linkedAccount, "id-1", "linked-new"),
      manageHash: newSubAddToken().hash,
      loginVerified: true,
    });
    assert.deepEqual(stored, { providerId: linked.provider.id, outcome: "updated" });
    assert.equal((await coolingDown([linked.route])).size, 0);
    assert.ok((await coolingDown([imported.route])).has(imported.route));

    const importedAccount = (await prisma.providerLogin.findUniqueOrThrow({ where: { providerId: imported.provider.id } })).account;
    const content = JSON.stringify({
      type: "claude",
      access_token: "imported-new",
      refresh_token: "imported-new-refresh",
      email: importedAccount,
      account_uuid: "id-1",
      expired: new Date(Date.now() + 8 * HOUR_MS).toISOString(),
    });
    const result = await importUploads(owner.user.id, [{ name: "claude.json", content }]);
    stopLocalCatalogTasks();
    assert.deepEqual(
      result.results.map((entry) => entry.status),
      ["updated"],
    );
    assert.equal(result.providers[0]?.id, imported.provider.id);
    assert.equal((await coolingDown([imported.route])).size, 0);
  } finally {
    await prisma.subAddLink.deleteMany({ where: { id: link.id } });
    await cleanup(owner, [linked.provider.id, imported.provider.id], [linked.alias, imported.alias]);
  }
});
