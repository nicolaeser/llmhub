import "./integration/support/oidc-env";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { digest } from "@/lib/crypto";
import { issuerCheckSchema, oidcSettingsSchema } from "@/schemas/settings";
import type { AuthenticatedSession } from "@/types/auth";

const SCIM_TOKEN = "scim_integration-token";
const OWNER = { id: "owner-1", email: "owner@example.test", username: "owner", blocked: false, isOwner: true, orgId: null, role: null };
const PERSON = { ...OWNER, id: "person-1", email: "person@example.test", username: "person", isOwner: false };

const scimToken = { setting: { findUnique: () => ({ key: "scim_token_hash", value: digest(SCIM_TOKEN) }) } };
let tokenUnderTest: string | null = null;

function scimRequest(method: string, path: string, token: string | null, body?: unknown) {
  return new Request(`http://hub.local/scim/v2/Users${path}`, {
    method,
    headers: {
      "content-type": "application/scim+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function scimHandlers() {
  const [collection, item] = await Promise.all([
    import("@/app/scim/v2/Users/route"),
    import("@/app/scim/v2/Users/[id]/route"),
  ]);
  const params = { params: Promise.resolve({ id: PERSON.id }) };
  return {
    collection,
    item,
    calls: [
      ["GET", () => collection.GET(scimRequest("GET", "", tokenUnderTest))],
      ["POST", () => collection.POST(scimRequest("POST", "", tokenUnderTest, { userName: "new@example.test" }))],
      ["GET item", () => item.GET(scimRequest("GET", `/${PERSON.id}`, tokenUnderTest), params)],
      ["PUT", () => item.PUT(scimRequest("PUT", `/${PERSON.id}`, tokenUnderTest, { userName: PERSON.email }), params)],
      ["PATCH", () => item.PATCH(scimRequest("PATCH", `/${PERSON.id}`, tokenUnderTest, { schemas: [], Operations: [] }), params)],
      ["DELETE", () => item.DELETE(scimRequest("DELETE", `/${PERSON.id}`, tokenUnderTest), params)],
    ] as const,
  };
}

test("SCIM route modules export only the SCIM user handlers", async () => {
  const { collection, item } = await scimHandlers();
  const handlers = (module: object) =>
    Object.entries(module)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
  assert.deepEqual(handlers(collection), ["GET", "POST"]);
  assert.deepEqual(handlers(item), ["DELETE", "GET", "PATCH", "PUT"]);
});

test("every SCIM handler rejects missing, wrong, and gateway tokens before touching users", async () => {
  const { calls } = await scimHandlers();
  for (const token of [null, "scim_wrong", "sk-hub-gateway-key"]) {
    tokenUnderTest = token;
    for (const [name, call] of calls) {
      recordedPrisma.reset(scimToken);
      const res = await call();
      assert.equal(res.status, 401, `${name} ${token}`);
      assert.equal(res.headers.get("content-type"), "application/scim+json");
      const body = await res.json();
      assert.deepEqual(body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
      assert.deepEqual(recordedPrisma.called("user"), [], name);
      assert.deepEqual(recordedPrisma.called("virtualKey"), [], name);
    }
  }
});

test("SCIM group and discovery routes reject requests without the SCIM token", async () => {
  const [groups, group, config, types, schemas] = await Promise.all([
    import("@/app/scim/v2/Groups/route"),
    import("@/app/scim/v2/Groups/[id]/route"),
    import("@/app/scim/v2/ServiceProviderConfig/route"),
    import("@/app/scim/v2/ResourceTypes/route"),
    import("@/app/scim/v2/Schemas/route"),
  ]);
  const params = { params: Promise.resolve({ id: "group-1" }) };
  const request = (method: string, token: string | null) =>
    new Request("http://hub.local/scim/v2/Groups/group-1", {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
  for (const token of [null, "scim_wrong"]) {
    const calls = [
      () => groups.GET(request("GET", token)),
      () => groups.POST(request("POST", token)),
      () => group.GET(request("GET", token), params),
      () => group.PUT(request("PUT", token), params),
      () => group.PATCH(request("PATCH", token), params),
      () => group.DELETE(request("DELETE", token), params),
      () => config.GET(request("GET", token)),
      () => types.GET(request("GET", token)),
      () => schemas.GET(request("GET", token)),
    ];
    for (const call of calls) {
      recordedPrisma.reset(scimToken);
      const res = await call();
      assert.equal(res.status, 401);
      assert.deepEqual(recordedPrisma.called("scimGroup"), []);
      assert.deepEqual(recordedPrisma.called("user"), []);
    }
  }
});

test("SCIM discovery describes users, groups, PATCH, and filters", async () => {
  const { GET } = await import("@/app/scim/v2/ServiceProviderConfig/route");
  const { GET: types } = await import("@/app/scim/v2/ResourceTypes/route");
  recordedPrisma.reset(scimToken);
  const config = await (await GET(scimRequest("GET", "", SCIM_TOKEN))).json();
  assert.equal(config.patch.supported, true);
  assert.equal(config.filter.supported, true);
  assert.equal(config.bulk.supported, false);
  assert.equal(config.authenticationSchemes[0].type, "oauthbearertoken");
  const list = await (await types(scimRequest("GET", "", SCIM_TOKEN))).json();
  assert.deepEqual(
    list.Resources.map((type: { endpoint: string }) => type.endpoint),
    ["/Users", "/Groups"],
  );
});

test("SCIM user lists page in the database and reject unsupported filters", async () => {
  const { collection } = await scimHandlers();
  recordedPrisma.reset({ ...scimToken, user: { findMany: () => [PERSON], count: () => 7 } });
  const res = await collection.GET(scimRequest("GET", "?startIndex=3&count=2&filter=externalId%20eq%20%22ext-1%22", SCIM_TOKEN));
  const body = await res.json();
  assert.equal(body.totalResults, 7);
  assert.equal(body.startIndex, 3);
  const args = recordedPrisma.called("user", "findMany")[0].args as { where: unknown; skip: number; take: number };
  assert.deepEqual(args.where, { externalId: "ext-1" });
  assert.equal(args.skip, 2);
  assert.equal(args.take, 2);
  recordedPrisma.reset(scimToken);
  const bad = await collection.GET(scimRequest("GET", "?filter=title%20co%20%22x%22", SCIM_TOKEN));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).scimType, "invalidFilter");
  assert.deepEqual(recordedPrisma.called("user"), []);
});

test("a valid SCIM token lists users as a SCIM list response", async () => {
  const { collection } = await scimHandlers();
  recordedPrisma.reset({ ...scimToken, user: { findMany: () => [PERSON], count: () => 1 } });
  tokenUnderTest = SCIM_TOKEN;
  const res = await collection.GET(scimRequest("GET", '?filter=userName eq "Person@Example.test"', SCIM_TOKEN));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/scim+json");
  const body = await res.json();
  assert.equal(body.totalResults, 1);
  assert.equal(body.Resources[0].userName, PERSON.email);
  assert.deepEqual(recordedPrisma.called("user", "findMany")[0].args, {
    where: { email: "person@example.test" },
    orderBy: { email: "asc" },
    skip: 0,
    take: 100,
    include: {
      role: { select: { templateKey: true, name: true } },
      scimGroups: { select: { group: { select: { id: true, displayName: true } } } },
    },
  });
});

test("SCIM cannot replace, patch, or delete the owner account", async () => {
  const { item } = await scimHandlers();
  const params = { params: Promise.resolve({ id: OWNER.id }) };
  const attempts = [
    () => item.PUT(scimRequest("PUT", `/${OWNER.id}`, SCIM_TOKEN, { userName: "taken@example.test", active: false }), params),
    () =>
      item.PATCH(
        scimRequest("PATCH", `/${OWNER.id}`, SCIM_TOKEN, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
        params,
      ),
    () => item.DELETE(scimRequest("DELETE", `/${OWNER.id}`, SCIM_TOKEN), params),
  ];
  for (const attempt of attempts) {
    recordedPrisma.reset({ ...scimToken, user: { findUnique: () => OWNER } });
    const res = await attempt();
    assert.equal(res.status, 403);
    assert.match((await res.json()).detail, /owner/);
    assert.deepEqual(
      recordedPrisma.calls.filter((call) => !["findUnique", "findFirst"].includes(call.method)).map((call) => `${call.model}.${call.method}`),
      [],
    );
  }
});

test("SCIM updates of other users are applied and audited", async () => {
  const { item } = await scimHandlers();
  recordedPrisma.reset({
    ...scimToken,
    user: { findUnique: () => PERSON, update: () => ({ ...PERSON, blocked: true }) },
  });
  const res = await item.PATCH(
    scimRequest("PATCH", `/${PERSON.id}`, SCIM_TOKEN, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
    { params: Promise.resolve({ id: PERSON.id }) },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).active, false);
  const update = recordedPrisma.called("user", "update")[0].args as { where: unknown; data: Record<string, unknown> };
  assert.deepEqual(update.where, { id: PERSON.id, isOwner: false });
  assert.equal(update.data.blocked, true);
  assert.deepEqual(update.data.sessions, { deleteMany: {} });
  const audit = recordedPrisma.called("gatewayAuditLog", "create")[0].args as { data: { action: string; actor: string } };
  assert.equal(audit.data.action, "scim.user.update");
  assert.equal(audit.data.actor, "scim");
});

test("SSO sign-in answers the same with or without users and waits for an enabled OIDC configuration", async () => {
  const { GET } = await import("@/app/sso/login/route");
  const answers = [];
  for (const users of [0, 1]) {
    recordedPrisma.reset({ user: { count: () => users } });
    const res = await GET(new NextRequest("http://localhost:3000/sso/login?return=/keys"));
    assert.deepEqual(recordedPrisma.called("user"), []);
    answers.push({ status: res.status, location: res.headers.get("location"), cookies: res.cookies.getAll() });
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(answers[0].status, 307);
  assert.equal(new URL(answers[0].location ?? "").searchParams.get("sso"), "disabled");
  assert.deepEqual(answers[0].cookies, []);
});

const TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ENTRA_TENANT_ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function enterpriseWithOidc(issuer: string) {
  const value = JSON.stringify({ oidc: { enabled: true, provider: "entra", issuer, client_id: "hub-client" } });
  return {
    user: { count: () => 1 },
    setting: { findUnique: ({ where }: { where: { key: string } }) => (where.key === "enterprise" ? { key: "enterprise", value } : null) },
  };
}

function discoveryAnswer(issuer: string, base = "https://login.microsoftonline.com/contoso.com"): typeof fetch {
  return async () =>
    Response.json({
      issuer,
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      token_endpoint: `${base}/oauth2/v2.0/token`,
      jwks_uri: `${base}/discovery/v2.0/keys`,
    });
}

async function withFetch<T>(fetchFn: typeof fetch, run: () => Promise<T>): Promise<T> {
  const { resetOidcCache } = await import("@/lib/auth/oidc");
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  resetOidcCache();
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    resetOidcCache();
  }
}

async function capturedLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const original = { error: console.error, log: console.log };
  const keep = (line: unknown) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  console.error = keep;
  console.log = keep;
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
}

test("SSO sign-in failures log the discovery reason and send users to the public login page", async () => {
  const { env } = await import("@/lib/env");
  const { GET } = await import("@/app/sso/login/route");
  const loginError = new URL("/account/login?sso=error", env.NEXT_PUBLIC_APP_URL).href;
  const attempts = [
    {
      fetchFn: discoveryAnswer(`https://sts.windows.net/${TENANT_ID}/`),
      fields: { reason: "issuer_mismatch", issuerHost: "sts.windows.net" },
    },
    {
      fetchFn: discoveryAnswer("https://login.microsoftonline.com/{tenantid}/v2.0"),
      fields: { reason: "multi_tenant", issuerHost: "login.microsoftonline.com" },
    },
    { fetchFn: (async () => new Response("bad gateway", { status: 502 })) as typeof fetch, fields: { reason: "http", status: 502 } },
    {
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      fields: { reason: "unreachable" },
    },
  ];
  for (const attempt of attempts) {
    recordedPrisma.reset(enterpriseWithOidc("https://login.microsoftonline.com/organizations/v2.0"));
    const { result: res, lines } = await capturedLogs(() =>
      withFetch(attempt.fetchFn, () => GET(new NextRequest("http://0.0.0.0:3000/sso/login?return=/keys"))),
    );
    assert.equal(res.headers.get("location"), loginError);
    assert.equal(res.cookies.getAll().length, 0);
    const failed = lines.filter((line) => line.event === "sso.login.failed");
    assert.equal(failed.length, 1);
    const { ts, level, event, errName, err, ...fields } = failed[0];
    assert.ok(ts);
    assert.deepEqual([level, event, errName], ["error", "sso.login.failed", "OidcDiscoveryError"]);
    assert.match(String(err), /^oidc discovery /);
    assert.deepEqual(fields, attempt.fields);
    assert.doesNotMatch(JSON.stringify(lines), /integration-oidc-client-secret|hub-client/);
  }
});

test("SSO sign-in with an Entra tenant domain redirects to Microsoft", async () => {
  const { GET } = await import("@/app/sso/login/route");
  recordedPrisma.reset(enterpriseWithOidc("https://login.microsoftonline.com/contoso.com/v2.0/.well-known/openid-configuration"));
  const res = await withFetch(discoveryAnswer(ENTRA_TENANT_ISSUER), () =>
    GET(new NextRequest("http://0.0.0.0:3000/sso/login?return=/keys")),
  );
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, "https://login.microsoftonline.com/contoso.com/oauth2/v2.0/authorize");
  assert.equal(location.searchParams.get("client_id"), "hub-client");
  assert.ok(res.cookies.getAll().length > 0);
});

function settingsManager(): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "admin", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions: ["settings:read", "settings:manage"],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

test("the issuer check explains why discovery failed and resolves Entra tenant domains", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { checkOidcIssuer } = await import("@/lib/settings/sign-in");
  const check = (issuer: string, fetchFn: typeof fetch) =>
    capturedLogs(() => withFetch(fetchFn, () => runAsPrincipal(settingsManager(), () => checkOidcIssuer({ issuer })))).then(
      ({ result }) => result,
    );
  const domain = "https://login.microsoftonline.com/contoso.com/v2.0";
  assert.deepEqual(await check(domain, discoveryAnswer(ENTRA_TENANT_ISSUER)), {
    ok: true,
    issuer: ENTRA_TENANT_ISSUER,
    usesTenantId: true,
    tokenAuth: "client_secret_post",
    algorithms: [],
    supported: true,
  });
  const tenant = await check(`${ENTRA_TENANT_ISSUER}/.well-known/openid-configuration`, discoveryAnswer(ENTRA_TENANT_ISSUER));
  assert.deepEqual([tenant.ok, tenant.ok && tenant.usesTenantId], [true, false]);
  assert.deepEqual(await check(`https://login.microsoftonline.com/${TENANT_ID}`, discoveryAnswer(`https://sts.windows.net/${TENANT_ID}/`)), {
    ok: false,
    reason: "issuer_mismatch",
    issuer: `https://sts.windows.net/${TENANT_ID}/`,
  });
  assert.deepEqual(
    await check("https://login.microsoftonline.com/common/v2.0", discoveryAnswer("https://login.microsoftonline.com/{tenantid}/v2.0")),
    { ok: false, reason: "multi_tenant", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" },
  );
  assert.deepEqual(await check(domain, async () => new Response("missing", { status: 404 })), {
    ok: false,
    reason: "http",
    status: 404,
  });
  assert.deepEqual(await check(domain, async () => new Response("<html></html>", { status: 200 })), {
    ok: false,
    reason: "not_json",
  });
  assert.deepEqual(
    await check(domain, async () => {
      throw new TypeError("fetch failed");
    }),
    { ok: false, reason: "unreachable" },
  );
  assert.deepEqual(await check(domain, async () => Response.json({ issuer: ENTRA_TENANT_ISSUER })), {
    ok: false,
    reason: "incomplete",
  });
});

test("issuer settings store the issuer without a pasted discovery suffix", () => {
  const pasted = "https://id.example.test/realms/hub/.well-known/openid-configuration";
  assert.equal(issuerCheckSchema.parse({ issuer: pasted }).issuer, "https://id.example.test/realms/hub");
  assert.equal(issuerCheckSchema.safeParse({ issuer: "   " }).success, false);
  const parsed = oidcSettingsSchema.parse({
    enabled: true,
    provider: "keycloak",
    issuer: `${pasted}/`,
    client_id: "hub",
    scopes: "openid",
    groups_claim: "",
    role_mappings: [],
    default_role_id: "",
    default_org_id: "",
    allowed_domains: [],
    sso_only: false,
  });
  assert.equal(parsed.issuer, "https://id.example.test/realms/hub");
});

test("the SSO callback refuses requests without a matching signed state before any lookup", async () => {
  const { GET } = await import("@/app/sso/callback/route");
  const { signOidcState, OIDC_STATE_COOKIE } = await import("@/lib/auth/oidc");
  const state = signOidcState({ returnPath: "/keys" });
  const tampered = `${state.cookie.slice(0, -1)}${state.cookie.endsWith("0") ? "1" : "0"}`;
  const attempts = [
    new NextRequest(`http://localhost:3000/sso/callback?code=abc&state=${state.state}`),
    new NextRequest(`http://localhost:3000/sso/callback?code=abc&state=${state.nonce}`, {
      headers: { cookie: `${OIDC_STATE_COOKIE}=${state.cookie}` },
    }),
    new NextRequest(`http://localhost:3000/sso/callback?code=abc&state=${state.state}`, {
      headers: { cookie: `${OIDC_STATE_COOKIE}=${tampered}` },
    }),
    new NextRequest(`http://localhost:3000/sso/callback?error=access_denied&state=${state.state}`, {
      headers: { cookie: `${OIDC_STATE_COOKIE}=${state.cookie}` },
    }),
  ];
  for (const request of attempts) {
    recordedPrisma.reset({ user: { count: () => 1 } });
    const res = await GET(request);
    assert.equal(new URL(res.headers.get("location") ?? "").searchParams.get("sso"), "error");
    assert.equal(res.cookies.get(OIDC_STATE_COOKIE)?.value, "");
    assert.equal(res.cookies.get(SESSION_COOKIE), undefined);
    assert.deepEqual(recordedPrisma.calls, []);
  }
});

test("an SSO callback that would create the first user fails like any other SSO failure", async () => {
  const { GET } = await import("@/app/sso/callback/route");
  const { env } = await import("@/lib/env");
  const { signOidcState, OIDC_STATE_COOKIE } = await import("@/lib/auth/oidc");
  const issuer = "https://first-user.idp.example.test";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const state = signOidcState({ returnPath: "/keys" });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: "first-user" })}.${encode({
    iss: issuer,
    aud: "hub-client",
    exp: now + 300,
    iat: now,
    nonce: state.nonce,
    sub: "first-subject",
    email: "first@example.test",
    email_verified: true,
  })}`;
  const idToken = `${body}.${sign("sha256", Buffer.from(body), keys.privateKey).toString("base64url")}`;
  const identityProvider = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url === `${issuer}/token`) return Response.json({ id_token: idToken });
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "first-user", alg: "RS256", use: "sig" }] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const value = JSON.stringify({ oidc: { enabled: true, issuer, client_id: "hub-client" } });
  recordedPrisma.reset({
    user: { count: () => 0 },
    setting: { findUnique: ({ where }: { where: { key: string } }) => (where.key === "enterprise" ? { key: "enterprise", value } : null) },
  });
  const { result: res, lines } = await capturedLogs(() =>
    withFetch(identityProvider, () =>
      GET(
        new NextRequest(`http://localhost:3000/sso/callback?code=abc&state=${state.state}`, {
          headers: { cookie: `${OIDC_STATE_COOKIE}=${state.cookie}` },
        }),
      ),
    ),
  );
  assert.equal(res.headers.get("location"), new URL("/account/login?sso=error", env.NEXT_PUBLIC_APP_URL).href);
  assert.equal(res.cookies.get(OIDC_STATE_COOKIE)?.value, "");
  assert.equal(res.cookies.get(SESSION_COOKIE), undefined);
  assert.equal(recordedPrisma.called("user", "count").length, 1);
  assert.deepEqual(recordedPrisma.called("user", "create"), []);
  assert.deepEqual(
    lines.filter((line) => line.event === "sso.callback.rejected").map((line) => line.reason),
    ["setup_required"],
  );
});

test("SSO and MCP OAuth redirects use the public app URL, not the internal bind address", async () => {
  const { env } = await import("@/lib/env");
  const { GET: login } = await import("@/app/sso/login/route");
  const { GET: callback } = await import("@/app/sso/callback/route");
  const { GET: mcpCallback } = await import("@/app/internal-api/mcp/oauth/callback/route");
  const publicOrigin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
  recordedPrisma.reset({ user: { count: () => 1 } });
  const responses = [
    await login(new NextRequest("http://0.0.0.0:3000/sso/login?return=/keys")),
    await callback(new NextRequest("http://0.0.0.0:3000/sso/callback?error=access_denied")),
    await callback(new NextRequest("http://0.0.0.0:3000/sso/callback?code=abc&state=xyz")),
    await mcpCallback(new NextRequest("http://0.0.0.0:3000/internal-api/mcp/oauth/callback?error=access_denied")),
  ];
  for (const res of responses) {
    const location = new URL(res.headers.get("location") ?? "");
    assert.equal(location.origin, publicOrigin);
    assert.notEqual(location.hostname, "0.0.0.0");
  }
  assert.equal(new URL(responses[0].headers.get("location") ?? "").pathname, "/account/login");
  assert.equal(new URL(responses[3].headers.get("location") ?? "").pathname, "/mcp");
});

test("route handlers never resolve URLs against the request URL", async () => {
  const appDir = new URL("../../src/app/", import.meta.url);
  const routes = (await readdir(appDir, { recursive: true })).filter((file) => /(^|\/)route\.ts$/.test(file));
  assert.ok(routes.length > 0);
  for (const file of routes) {
    const source = await readFile(new URL(file, appDir), "utf8");
    assert.doesNotMatch(source, /new URL\([^;]*,\s*req(?:uest)?\.(?:url|nextUrl)\s*\)/, file);
  }
});

test("sign-in settings carry OIDC but no JWT, custom auth, or redirect override", () => {
  const parsed = oidcSettingsSchema.parse({
    enabled: true,
    provider: "keycloak",
    issuer: "https://id.example.test/realms/hub",
    client_id: "hub",
    scopes: "openid email profile",
    groups_claim: "groups",
    role_mappings: [{ group: "llm-admins", role_id: "role-admin" }],
    default_role_id: "",
    default_org_id: "",
    allowed_domains: ["Example.TEST"],
    sso_only: false,
    redirect_url: "https://evil.example.test/callback",
    jwt: { issuer: "https://id.example.test", jwks_url: "https://id.example.test/jwks" },
    custom_auth_url: "https://auth.example.test",
  });
  assert.equal(parsed.client_id, "hub");
  assert.deepEqual(parsed.allowed_domains, ["example.test"]);
  for (const key of ["jwt", "custom_auth_url", "redirect_url"]) assert.equal(key in parsed, false, key);
  assert.equal(oidcSettingsSchema.safeParse({ ...parsed, allowed_domains: ["not a domain"] }).success, false);
});

test("there is no master key", async () => {
  for (const file of ["lib/gateway/access/principal.ts", "lib/bootstrap/system-catalog.ts", "lib/settings/sign-in.ts"]) {
    assert.doesNotMatch(await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8"), /master/i, file);
  }
});

test("the login password step opens SSO with a full-page navigation when it is enabled", async () => {
  const form = await readFile(
    new URL("../../src/app/account/login/_components/password-step.tsx", import.meta.url),
    "utf8",
  );
  assert.match(form, /ssoEnabled/);
  assert.match(form, /window\.location\.assign\(withReturnQuery\("\/sso\/login", returnParam\)\)/);
  assert.doesNotMatch(form, /router\.(replace|push)\([^)]*\/sso\/login/);
});
