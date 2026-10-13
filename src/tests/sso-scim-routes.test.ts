import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { digest } from "@/lib/crypto";
import { oidcSettingsSchema } from "@/schemas/settings";

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

test("SSO sign-in waits for setup and for an enabled OIDC configuration", async () => {
  const { GET } = await import("@/app/sso/login/route");
  const login = new NextRequest("http://localhost:3000/sso/login?return=/keys");

  recordedPrisma.reset({ user: { count: () => 0 } });
  const setup = await GET(login);
  assert.equal(setup.status, 307);
  assert.equal(new URL(setup.headers.get("location") ?? "").searchParams.get("sso"), "setup");

  recordedPrisma.reset({ user: { count: () => 1 } });
  const disabled = await GET(login);
  assert.equal(new URL(disabled.headers.get("location") ?? "").searchParams.get("sso"), "disabled");
  assert.equal(disabled.cookies.getAll().length, 0);
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

test("the login password step links to SSO when it is enabled", async () => {
  const form = await readFile(
    new URL("../../src/app/account/login/_components/password-step.tsx", import.meta.url),
    "utf8",
  );
  assert.match(form, /ssoEnabled/);
  assert.match(form, /\/sso\/login/);
});
