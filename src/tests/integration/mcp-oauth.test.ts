import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { McpError } from "@/lib/mcp/errors";
import { MCP_OAUTH_PENDING_COOKIE } from "@/lib/mcp/oauth";
import { completeMcpOAuth, disconnectMcpOAuth, startMcpOAuth } from "@/lib/mcp/server-oauth";
import { probeMcpServer } from "@/lib/mcp/server-probe";
import { createMcpServer, loadMcpServerList, updateMcpServer } from "@/lib/mcp/servers";
import { createExecutor, loadMcpServers, serverRecord } from "@/lib/mcp/toolset";
import type { JsonMap } from "@/types/gateway";
import type { McpBoundTool } from "@/types/mcp";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

type Code = { clientId: string; challenge: string; redirectUri: string; resource: string; scope: string };

const state = {
  port: 0,
  clients: new Map<string, { secret: string; redirectUris: string[] }>(),
  codes: new Map<string, Code>(),
  access: new Set<string>(),
  refresh: new Map<string, string>(),
  issued: 0,
  refuseRefresh: false,
  mcpAuth: [] as string[],
};

const base = () => `http://127.0.0.1:${state.port}`;
const issuer = () => `${base()}/auth`;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function issue(clientId: string, refresh = true) {
  state.issued += 1;
  const access = `at-${state.issued}`;
  state.access.add(access);
  const body: JsonMap = { access_token: access, token_type: "Bearer", expires_in: 3600, scope: "tools:read" };
  if (refresh) {
    body.refresh_token = `rt-${state.issued}`;
    state.refresh.set(`rt-${state.issued}`, clientId);
  }
  return body;
}

function basicClient(req: IncomingMessage): { id: string; secret: string } | null {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Basic ")) return null;
  const [id, secret] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
  return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
}

function token(req: IncomingMessage, res: ServerResponse, form: URLSearchParams) {
  const client = basicClient(req);
  const known = client ? state.clients.get(client.id) : undefined;
  if (!client || !known || known.secret !== client.secret) return json(res, 401, { error: "invalid_client" });
  const grant = form.get("grant_type");
  if (grant === "client_credentials") {
    if (form.get("resource") !== `${base()}/mcp`) return json(res, 400, { error: "invalid_target" });
    return json(res, 200, issue(client.id, false));
  }
  if (grant === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (state.refuseRefresh || state.refresh.get(refreshToken) !== client.id) return json(res, 400, { error: "invalid_grant" });
    state.refresh.delete(refreshToken);
    return json(res, 200, issue(client.id));
  }
  const code = state.codes.get(form.get("code") ?? "");
  state.codes.delete(form.get("code") ?? "");
  const verifier = form.get("code_verifier") ?? "";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (
    !code ||
    code.clientId !== client.id ||
    code.challenge !== challenge ||
    code.redirectUri !== form.get("redirect_uri") ||
    code.resource !== form.get("resource")
  ) {
    return json(res, 400, { error: "invalid_grant" });
  }
  return json(res, 200, issue(client.id));
}

function mcp(req: IncomingMessage, res: ServerResponse, body: JsonMap) {
  const auth = String(req.headers.authorization ?? "");
  state.mcpAuth.push(auth);
  if (!state.access.has(auth.replace(/^Bearer /, ""))) {
    res.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp", scope="tools:read"`,
    });
    res.end();
    return;
  }
  const result: JsonMap =
    body.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "Vault" } } }
      : body.method === "tools/list"
        ? { tools: [{ name: "lookup", inputSchema: { type: "object", properties: { key: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `value of ${String(((body.params as JsonMap).arguments as JsonMap).key)}` }] };
  json(res, 200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...result } });
}

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  const path = new URL(req.url ?? "/", base()).pathname;
  if (req.method === "POST" && path === "/mcp") return mcp(req, res, JSON.parse(raw) as JsonMap);
  if (path === "/.well-known/oauth-protected-resource/mcp") {
    return json(res, 200, { resource: `${base()}/mcp`, authorization_servers: [issuer()], scopes_supported: ["tools:read"] });
  }
  if (path === "/.well-known/oauth-authorization-server/auth") {
    return json(res, 200, {
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/authorize`,
      token_endpoint: `${issuer()}/token`,
      registration_endpoint: `${issuer()}/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      scopes_supported: ["tools:read", "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (req.method === "POST" && path === "/auth/register") {
    const meta = JSON.parse(raw) as JsonMap;
    const id = `dyn-${state.clients.size + 1}`;
    state.clients.set(id, { secret: `${id}-secret`, redirectUris: meta.redirect_uris as string[] });
    return json(res, 201, { client_id: id, client_secret: `${id}-secret`, token_endpoint_auth_method: "client_secret_basic" });
  }
  if (req.method === "POST" && path === "/auth/token") return token(req, res, new URLSearchParams(raw));
  json(res, 404, { error: "not_found" });
});

function approve(authorizeUrl: string) {
  const url = new URL(authorizeUrl);
  const params = url.searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  assert.equal(url.origin + url.pathname, `${issuer()}/authorize`);
  assert.ok(state.clients.get(clientId)?.redirectUris.includes(redirectUri));
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("resource"), `${base()}/mcp`);
  assert.equal(params.get("scope"), "tools:read offline_access");
  const code = `code-${state.codes.size + state.issued + 1}`;
  state.codes.set(code, {
    clientId,
    challenge: params.get("code_challenge") ?? "",
    redirectUri,
    resource: params.get("resource") ?? "",
    scope: params.get("scope") ?? "",
  });
  return { code, state: params.get("state") ?? "", iss: issuer(), error: "" };
}

const bound = (serverId: string): McpBoundTool => ({
  name: "mcp__vault__lookup",
  serverId,
  serverName: "vault",
  tool: { name: "lookup", title: "", description: "", inputSchema: { type: "object" } },
});

async function callTool(serverId: string) {
  const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
  const executor = createExecutor(new Map([[serverId, serverRecord(row)]]));
  try {
    return await executor.call(bound(serverId), { key: "alpha" }, AbortSignal.timeout(10_000));
  } finally {
    await executor.close();
  }
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.clients.set("m2m", { secret: "m2m-secret", redirectUris: [] });
});

after(async () => {
  server.close();
  await closeDatabase();
});

const input = (overrides: Partial<Record<string, unknown>> = {}) => ({
  name: uniqueName("vault").slice(0, 40),
  description: "",
  url: `${base()}/mcp`,
  authType: "oauth",
  authHeader: "",
  secret: "",
  clearSecret: false,
  oauthGrant: "authorization_code",
  oauthClientId: "",
  oauthScopes: "",
  internal: true,
  enabled: true,
  global: false,
  toolsRestricted: false,
  allowedTools: [],
  ...overrides,
});

test("an operator signs in to an OAuth MCP server and the gateway keeps the token fresh", async () => {
  const owner = await ownerSession();
  const ids: string[] = [];
  try {
    const created = await runAsPrincipal(owner, () => createMcpServer(input()));
    const id = created.server.id;
    ids.push(id);
    assert.equal(created.server.status, "signin");
    assert.equal(created.server.lastError, "MCP_AUTH_REQUIRED");

    const probe = await runAsPrincipal(owner, () =>
      probeMcpServer({ id, url: `${base()}/mcp`, authType: "oauth", authHeader: "", secret: "", internal: true }),
    );
    assert.equal(probe.error, "MCP_AUTH_REQUIRED");

    const started = await runAsPrincipal(owner, () => startMcpOAuth(id));
    const pendingCookie = (await cookies()).get(MCP_OAUTH_PENDING_COOKIE)?.value ?? "";
    assert.ok(pendingCookie.startsWith("enc1:"));
    const answer = approve(started.url);

    const done = await runAsPrincipal(owner, () => completeMcpOAuth(answer));
    assert.equal((await cookies()).get(MCP_OAUTH_PENDING_COOKIE), undefined);
    assert.equal(done.server.status, "connected");
    assert.deepEqual(done.server.tools.map((tool) => tool.name), ["lookup"]);
    assert.equal(done.server.era, "modern");
    assert.equal(done.server.oauth?.status, "active");
    assert.equal(done.server.oauth?.scope, "tools:read");

    const login = await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } });
    assert.ok(login.tokens.startsWith("enc1:") && login.client.startsWith("enc1:"));
    assert.ok(!login.tokens.includes("at-") && !login.client.includes("secret"));
    assert.equal(login.issuer, issuer());
    assert.equal(await prisma.gatewayAuditLog.count({ where: { objectId: id, action: "mcp_server.oauth_connect" } }), 1);

    assert.deepEqual(await callTool(id), { text: "value of alpha", isError: false });
    const firstToken = state.mcpAuth.at(-1);

    await prisma.mcpOAuthLogin.update({ where: { serverId: id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    assert.deepEqual(await callTool(id), { text: "value of alpha", isError: false });
    const renewed = await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } });
    assert.equal(renewed.version, login.version + 1);
    assert.notEqual(state.mcpAuth.at(-1), firstToken);

    state.access.delete(String(state.mcpAuth.at(-1)).replace(/^Bearer /, ""));
    assert.deepEqual(await callTool(id), { text: "value of alpha", isError: false });
    assert.equal((await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } })).version, login.version + 2);

    state.refuseRefresh = true;
    await prisma.mcpOAuthLogin.update({ where: { serverId: id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await assert.rejects(callTool(id), (err) => err instanceof McpError && err.code === "MCP_AUTH_REQUIRED");
    state.refuseRefresh = false;
    assert.equal((await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } })).status, "expired");
    const listed = await runAsPrincipal(owner, () => loadMcpServerList());
    assert.equal(listed.servers.find((row) => row.id === id)?.status, "signin");
    assert.equal(listed.redirectUri, "http://localhost:3000/internal-api/mcp/oauth/callback");

    const again = await runAsPrincipal(owner, () => startMcpOAuth(id));
    const reused = new URL(again.url).searchParams.get("client_id");
    assert.equal(reused, new URL(started.url).searchParams.get("client_id"));
    const forged = { ...approve(again.url), iss: "http://evil.test" };
    await assert.rejects(
      runAsPrincipal(owner, () => completeMcpOAuth(forged)),
      (err) => err instanceof McpError && err.code === "MCP_OAUTH_STATE",
    );
    await assert.rejects(
      runAsPrincipal(owner, () => completeMcpOAuth(approve(again.url))),
      (err) => err instanceof McpError && err.code === "MCP_OAUTH_STATE",
    );

    const chain = { orgId: "", teamId: "", projectId: "", memberId: "", keyId: "" };
    await prisma.mcpServer.update({ where: { id }, data: { global: true } });
    assert.equal((await loadMcpServers(chain)).servers.some((row) => row.serverId === id), false);
    await prisma.mcpOAuthLogin.update({ where: { serverId: id }, data: { status: "active" } });
    assert.equal((await loadMcpServers(chain)).servers.some((row) => row.serverId === id), true);

    const signedOut = await runAsPrincipal(owner, () => disconnectMcpOAuth(id));
    assert.equal(signedOut.server.status, "signin");
    assert.equal(signedOut.server.oauth, null);
    assert.equal(await prisma.mcpOAuthLogin.count({ where: { serverId: id } }), 0);
    assert.equal((await loadMcpServers(chain)).servers.some((row) => row.serverId === id), false);
  } finally {
    await prisma.mcpServer.deleteMany({ where: { id: { in: ids } } });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectType: "mcp_server", actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});

test("client credentials connect without a person and reset when the server changes", async () => {
  const owner = await ownerSession();
  const ids: string[] = [];
  try {
    const trial = await runAsPrincipal(owner, () =>
      probeMcpServer({
        url: `${base()}/mcp`,
        authType: "oauth",
        authHeader: "",
        secret: "m2m-secret",
        internal: true,
        oauthGrant: "client_credentials",
        oauthClientId: "m2m",
      }),
    );
    assert.equal(trial.connected, true);
    assert.equal(await prisma.mcpOAuthLogin.count({ where: { server: { url: `${base()}/mcp` }, issuer: issuer() } }), 0);

    await assert.rejects(
      runAsPrincipal(owner, () => createMcpServer(input({ oauthGrant: "client_credentials", oauthClientId: "m2m" }))),
      /MCP_SECRET_REQUIRED/,
    );
    const created = await runAsPrincipal(owner, () =>
      createMcpServer(input({ oauthGrant: "client_credentials", oauthClientId: "m2m", secret: "m2m-secret" })),
    );
    const id = created.server.id;
    ids.push(id);
    assert.equal(created.server.status, "connected");
    assert.equal(created.server.oauth?.status, "active");
    const login = await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } });
    assert.equal(login.issuer, issuer());

    await prisma.mcpOAuthLogin.update({ where: { serverId: id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    assert.deepEqual(await callTool(id), { text: "value of alpha", isError: false });
    assert.ok((await prisma.mcpOAuthLogin.findUniqueOrThrow({ where: { serverId: id } })).version > login.version);

    const updated = await runAsPrincipal(owner, () =>
      updateMcpServer({ id, ...input({ name: created.server.name, oauthGrant: "client_credentials", oauthClientId: "other" }) }),
    );
    assert.equal(updated.server.lastError, "MCP_OAUTH_TOKEN");
    assert.equal(await prisma.mcpOAuthLogin.count({ where: { serverId: id } }), 0);
  } finally {
    await prisma.mcpServer.deleteMany({ where: { id: { in: ids } } });
    await prisma.gatewayAuditLog.deleteMany({ where: { objectType: "mcp_server", actor: owner.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  }
});
