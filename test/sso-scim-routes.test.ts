import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { digest } from "@/lib/crypto";
import { adminSettingsSchema } from "@/schemas/settings";

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

test("a valid SCIM token lists users as a SCIM list response", async () => {
  const { collection } = await scimHandlers();
  recordedPrisma.reset({ ...scimToken, user: { findMany: () => [PERSON] } });
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
    include: { role: { select: { templateKey: true, name: true } } },
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

test("admin settings carry OIDC but no JWT or custom auth configuration", () => {
  const input = {
    registration_enabled: false,
    assistant_model: "",
    update_check: false,
    catalog_auto_routes: true,
    catalog_min_confidence: 0.8,
    catalog_jev: { enabled: false, model: "", api_key: "", clear_api_key: false },
    oidc: { enabled: true, issuer: "https://id.example.test", client_id: "hub", redirect_url: "" },
    s3: {
      enabled: false,
      bucket: "",
      region: "",
      endpoint: "",
      prefix: "",
      addressing: "auto",
      public_base_url: "",
      domain_bucket: false,
    },
    jwt: { issuer: "https://id.example.test", jwks_url: "https://id.example.test/jwks" },
    custom_auth_url: "https://auth.example.test",
  };
  const parsed = adminSettingsSchema.parse(input);
  assert.equal(parsed.oidc.client_id, "hub");
  assert.equal("jwt" in parsed, false);
  assert.equal("custom_auth_url" in parsed, false);
});

test("there is no master key", async () => {
  for (const file of ["lib/gateway/access/principal.ts", "lib/bootstrap/system-catalog.ts", "lib/settings/admin.ts"]) {
    assert.doesNotMatch(await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"), /master/i, file);
  }
});

test("the login password step links to SSO when it is enabled", async () => {
  const form = await readFile(
    new URL("../src/app/account/login/_components/password-step.tsx", import.meta.url),
    "utf8",
  );
  assert.match(form, /ssoEnabled/);
  assert.match(form, /\/sso\/login/);
});
