import assert from "node:assert/strict";
import test from "node:test";
import { pkceChallenge, seal } from "@/lib/crypto";
import { McpError } from "@/lib/mcp/errors";
import {
  authServerMetadataUrls,
  authorizationUrl,
  canonicalResource,
  discoverOAuth,
  issuerAccepted,
  manualClient,
  mcpClientMetadata,
  metadataDocumentUsable,
  newPending,
  openPending,
  parseAuthServer,
  redirectAllowed,
  registerClient,
  resourceMatches,
  resourceMetadataUrls,
  sealPending,
  selectScope,
  tokenRequest,
} from "@/lib/mcp/oauth";
import type { JsonMap } from "@/types/gateway";
import type { McpAuthServer, McpFetch } from "@/types/mcp";

const AS: McpAuthServer = {
  issuer: "https://auth.test/tenant",
  authorizationEndpoint: "https://auth.test/tenant/authorize?prompt=consent",
  tokenEndpoint: "https://auth.test/tenant/token",
  registrationEndpoint: "https://auth.test/tenant/register",
  scopesSupported: ["files:read", "offline_access"],
  codeChallengeMethods: ["S256"],
  tokenAuthMethods: ["client_secret_post", "none"],
  clientMetadataDocuments: false,
  issParameter: true,
};

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

function recorder(routes: Record<string, (seen: Seen) => Response>) {
  const seen: Seen[] = [];
  const fetch: McpFetch = async (url, init) => {
    const entry = { url, method: init.method, headers: init.headers, body: init.body ?? "" };
    seen.push(entry);
    const route = routes[`${init.method} ${url}`];
    return route ? route(entry) : new Response("missing", { status: 404 });
  };
  return { fetch, seen };
}

test("protected resource and authorization server metadata URLs follow the discovery order", () => {
  assert.deepEqual(resourceMetadataUrls("https://mcp.test/public/mcp/", null), [
    "https://mcp.test/.well-known/oauth-protected-resource/public/mcp",
    "https://mcp.test/.well-known/oauth-protected-resource",
  ]);
  assert.deepEqual(
    resourceMetadataUrls("https://mcp.test/mcp", { resourceMetadata: "https://mcp.test/prm", scope: "", error: "" })[0],
    "https://mcp.test/prm",
  );
  assert.deepEqual(resourceMetadataUrls("https://mcp.test", null), ["https://mcp.test/.well-known/oauth-protected-resource"]);
  assert.deepEqual(authServerMetadataUrls("https://auth.test"), [
    "https://auth.test/.well-known/oauth-authorization-server",
    "https://auth.test/.well-known/openid-configuration",
  ]);
  assert.deepEqual(authServerMetadataUrls("https://auth.test/tenant1"), [
    "https://auth.test/.well-known/oauth-authorization-server/tenant1",
    "https://auth.test/.well-known/openid-configuration/tenant1",
    "https://auth.test/tenant1/.well-known/openid-configuration",
  ]);
});

test("resources are canonical and must cover the server URL", () => {
  assert.equal(canonicalResource("HTTPS://MCP.Example.com/"), "https://mcp.example.com");
  assert.equal(canonicalResource("https://mcp.example.com/mcp#frag"), "https://mcp.example.com/mcp");
  assert.ok(resourceMatches("https://mcp.test", "https://mcp.test/mcp"));
  assert.ok(resourceMatches("https://mcp.test/mcp", "https://mcp.test/mcp"));
  assert.ok(!resourceMatches("https://mcp.test/mc", "https://mcp.test/mcp"));
  assert.ok(!resourceMatches("https://other.test", "https://mcp.test/mcp"));
});

test("authorization server metadata must name the issuer it was fetched for", () => {
  const json = {
    issuer: "https://auth.test/tenant",
    authorization_endpoint: "https://auth.test/tenant/authorize",
    token_endpoint: "https://auth.test/tenant/token",
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
  const parsed = parseAuthServer(json, "https://auth.test/tenant");
  assert.equal(parsed?.issParameter, true);
  assert.equal(parsed?.clientMetadataDocuments, true);
  assert.equal(parseAuthServer({ ...json, issuer: "https://honest.test" }, "https://auth.test/tenant"), null);
  assert.equal(parseAuthServer({ ...json, token_endpoint: undefined }, "https://auth.test/tenant"), null);
});

test("scope selection prefers the operator, then the challenge, then the metadata", () => {
  const base = { previous: "", server: AS, offline: true, metadata: null };
  assert.equal(selectScope({ ...base, configured: " a  b ", challenge: null }), "a b");
  assert.equal(
    selectScope({ ...base, configured: "", challenge: { resourceMetadata: "", scope: "files:read", error: "" } }),
    "files:read offline_access",
  );
  assert.equal(
    selectScope({
      ...base,
      configured: "",
      previous: "files:write",
      challenge: null,
      metadata: { resource: "https://mcp.test", authorizationServers: [], scopesSupported: ["files:read"] },
    }),
    "files:write files:read offline_access",
  );
  assert.equal(selectScope({ ...base, configured: "", challenge: null }), "");
});

test("discovery follows the 401 challenge to the resource and authorization server metadata", async () => {
  const server = recorder({
    "POST https://mcp.test/mcp": () =>
      new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="files:read"' },
      }),
    "GET https://mcp.test/.well-known/oauth-protected-resource/mcp": () =>
      Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test/tenant"] }),
    "GET https://auth.test/.well-known/openid-configuration/tenant": () =>
      Response.json({
        issuer: "https://auth.test/tenant",
        authorization_endpoint: "https://auth.test/tenant/authorize",
        token_endpoint: "https://auth.test/tenant/token",
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["files:read", "offline_access"],
      }),
  });
  const found = await discoverOAuth({ url: "https://mcp.test/mcp", scopes: "", previousScope: "", offline: true }, server.fetch);
  assert.equal(found.resource, "https://mcp.test/mcp");
  assert.equal(found.scope, "files:read offline_access");
  assert.equal(found.server.tokenEndpoint, "https://auth.test/tenant/token");
  assert.deepEqual(
    server.seen.map((call) => `${call.method} ${call.url}`),
    [
      "POST https://mcp.test/mcp",
      "GET https://mcp.test/.well-known/oauth-protected-resource/mcp",
      "GET https://auth.test/.well-known/oauth-authorization-server/tenant",
      "GET https://auth.test/.well-known/openid-configuration/tenant",
    ],
  );
  assert.equal(server.seen[0]!.headers["MCP-Protocol-Version"], "2026-07-28");
});

test("discovery rejects foreign resources and falls back to the server origin without resource metadata", async () => {
  const foreign = recorder({
    "GET https://mcp.test/.well-known/oauth-protected-resource": () =>
      Response.json({ resource: "https://elsewhere.test", authorization_servers: ["https://auth.test"] }),
  });
  await assert.rejects(
    discoverOAuth({ url: "https://mcp.test", scopes: "", previousScope: "", offline: false }, foreign.fetch),
    (err) => err instanceof McpError && err.code === "MCP_OAUTH_DISCOVERY",
  );
  const origin = recorder({
    "GET https://mcp.test/.well-known/oauth-authorization-server": () =>
      Response.json({ issuer: "https://mcp.test", token_endpoint: "https://mcp.test/token" }),
  });
  const found = await discoverOAuth({ url: "https://mcp.test/mcp", scopes: "", previousScope: "", offline: false }, origin.fetch);
  assert.equal(found.server.issuer, "https://mcp.test");
  assert.equal(found.resource, "https://mcp.test/mcp");
});

test("dynamic registration sends the redirect URI, grant types, and application type", async () => {
  const server = recorder({
    "POST https://auth.test/tenant/register": () =>
      Response.json({ client_id: "dyn-1", client_secret: "shh", token_endpoint_auth_method: "client_secret_post" }, { status: 201 }),
  });
  const client = await registerClient({ server: AS, scope: "files:read", redirectUri: "http://localhost:3000/cb" }, server.fetch);
  assert.deepEqual(client, {
    clientId: "dyn-1",
    clientSecret: "shh",
    authMethod: "client_secret_post",
    registration: "dynamic",
    redirectUri: "http://localhost:3000/cb",
  });
  const sent = JSON.parse(server.seen[0]!.body) as JsonMap;
  assert.deepEqual(sent.redirect_uris, ["http://localhost:3000/cb"]);
  assert.deepEqual(sent.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(sent.application_type, "native");
  assert.equal(sent.token_endpoint_auth_method, "client_secret_post");
  await assert.rejects(
    registerClient({ server: { ...AS, registrationEndpoint: "" }, scope: "", redirectUri: "x" }, server.fetch),
    (err) => err instanceof McpError && err.code === "MCP_OAUTH_CLIENT_REQUIRED",
  );
});

test("client metadata documents need a public https console", () => {
  assert.equal(metadataDocumentUsable("https://hub.example.com"), true);
  assert.equal(metadataDocumentUsable("https://localhost"), false);
  assert.equal(metadataDocumentUsable("https://10.0.0.5"), false);
  assert.equal(metadataDocumentUsable("http://hub.example.com"), false);
  assert.equal(redirectAllowed("http://localhost:3000"), true);
  assert.equal(redirectAllowed("http://hub.example.com"), false);
  assert.deepEqual(mcpClientMetadata("https://hub.example.com/"), {
    client_id: "https://hub.example.com/internal-api/mcp/oauth/client",
    client_name: "LLM Hub",
    client_uri: "https://hub.example.com",
    redirect_uris: ["https://hub.example.com/internal-api/mcp/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

test("the authorization URL carries PKCE, state, resource, and scope", () => {
  const client = manualClient({ clientId: "pre", sealedSecret: seal("secret"), redirectUri: "https://hub.test/cb" }, AS);
  assert.equal(client.authMethod, "client_secret_post");
  assert.equal(client.clientSecret, "secret");
  const pending = newPending({
    serverId: "srv",
    userId: "u1",
    url: "https://mcp.test/mcp",
    issuer: AS.issuer,
    issParameter: true,
    tokenEndpoint: AS.tokenEndpoint,
    resource: "https://mcp.test/mcp",
    scope: "files:read",
    client,
  });
  const url = new URL(authorizationUrl(AS, client, pending));
  assert.equal(url.origin + url.pathname, "https://auth.test/tenant/authorize");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "pre");
  assert.equal(url.searchParams.get("redirect_uri"), "https://hub.test/cb");
  assert.equal(url.searchParams.get("state"), pending.state);
  assert.equal(url.searchParams.get("code_challenge"), pkceChallenge(pending.verifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.test/mcp");
  assert.equal(url.searchParams.get("scope"), "files:read");
  assert.equal(manualClient({ clientId: "public", sealedSecret: "", redirectUri: "x" }, AS).authMethod, "none");
});

test("the pending sign-in is sealed, expires, and rejects tampering", () => {
  const client = manualClient({ clientId: "pre", sealedSecret: "", redirectUri: "https://hub.test/cb" }, AS);
  const pending = newPending(
    {
      serverId: "srv",
      userId: "u1",
      url: "https://mcp.test/mcp",
      issuer: AS.issuer,
      issParameter: false,
      tokenEndpoint: AS.tokenEndpoint,
      resource: "https://mcp.test/mcp",
      scope: "",
      client,
    },
    1_000_000,
  );
  const sealed = sealPending(pending);
  assert.ok(!sealed.includes("srv"));
  assert.deepEqual(openPending(sealed, 1_000_000 + 60_000), pending);
  assert.equal(openPending(sealed, 1_000_000 + 11 * 60_000), null);
  assert.equal(openPending(`${sealed.slice(0, -4)}AAAA`, 1_000_000), null);
  assert.equal(openPending("enc1:garbage", 1_000_000), null);
});

test("the issuer parameter is checked against the recorded issuer", () => {
  const strict = { issuer: "https://auth.test", issParameter: true };
  const lax = { issuer: "https://auth.test", issParameter: false };
  assert.equal(issuerAccepted(strict, "https://auth.test"), true);
  assert.equal(issuerAccepted(strict, null), false);
  assert.equal(issuerAccepted(strict, "https://auth.test/"), false);
  assert.equal(issuerAccepted(lax, null), true);
  assert.equal(issuerAccepted(lax, "https://evil.test"), false);
});

test("token requests authenticate the client and parse the grant", async () => {
  const server = recorder({
    "POST https://auth.test/token": (seen) => {
      const form = new URLSearchParams(seen.body);
      if (form.get("grant_type") === "refresh_token") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (form.get("grant_type") === "dpop") return Response.json({ access_token: "a", token_type: "DPoP" });
      return Response.json({ access_token: "at", token_type: "Bearer", refresh_token: "rt", expires_in: 60, scope: "files:read" });
    },
  });
  const grant = await tokenRequest(
    server.fetch,
    "https://auth.test/token",
    { clientId: "id:1", clientSecret: "s&cret", authMethod: "client_secret_basic" },
    { grant_type: "authorization_code", code: "c", resource: "https://mcp.test/mcp", scope: "" },
    1_000,
  );
  assert.deepEqual(grant, { access: "at", refresh: "rt", scope: "files:read", expiresAt: new Date(61_000) });
  const first = server.seen[0]!;
  assert.equal(first.headers.Authorization, `Basic ${Buffer.from("id%3A1:s%26cret").toString("base64")}`);
  const form = new URLSearchParams(first.body);
  assert.equal(form.get("resource"), "https://mcp.test/mcp");
  assert.equal(form.has("scope"), false);
  assert.equal(form.has("client_id"), false);

  await tokenRequest(server.fetch, "https://auth.test/token", { clientId: "pub", clientSecret: "", authMethod: "none" }, { grant_type: "x" });
  assert.equal(new URLSearchParams(server.seen[1]!.body).get("client_id"), "pub");
  assert.equal(server.seen[1]!.headers.Authorization, undefined);

  await assert.rejects(
    tokenRequest(server.fetch, "https://auth.test/token", { clientId: "c", clientSecret: "", authMethod: "none" }, { grant_type: "refresh_token" }),
    (err) => err instanceof McpError && err.code === "MCP_OAUTH_TOKEN" && err.detail === "invalid_grant",
  );
  await assert.rejects(
    tokenRequest(server.fetch, "https://auth.test/token", { clientId: "c", clientSecret: "", authMethod: "none" }, { grant_type: "dpop" }),
    (err) => err instanceof McpError && err.code === "MCP_OAUTH_TOKEN" && err.detail === "unsupported token type",
  );
});
