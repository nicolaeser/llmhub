import assert from "node:assert/strict";
import test from "node:test";
import {
  appRolesOffered,
  buildAuthorizationUrl,
  emailFromOidcClaims,
  exchangeOidcCode,
  fetchOidcDiscovery,
  jwtConfigForOidc,
  OidcDiscoveryError,
  oidcFailureFields,
  oidcIsReady,
  resetOidcCache,
  resolveOidc,
  signOidcState,
  claimValues,
  identityFromClaims,
  tokenAuthMethod,
  tokenRequest,
  verifyOidcState,
} from "@/lib/auth/oidc";
import { verifyJwt } from "@/lib/auth/jwks";
import {
  appRoleTemplates,
  emailDomainAllowed,
  entraV2Issuer,
  mappedRoleId,
  oidcScopes,
  suggestedIssuer,
  trimIssuer,
} from "@/lib/auth/oidc-presets";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { pkceChallenge } from "@/lib/crypto";
import type { OidcDiscovery } from "@/types/auth";

test("trimIssuer drops trailing slashes and a pasted discovery suffix", () => {
  assert.equal(trimIssuer("https://idp.example.com/"), "https://idp.example.com");
  assert.equal(trimIssuer("https://idp.example.com///"), "https://idp.example.com");
  assert.equal(trimIssuer(" https://idp.example.com/realms/hub/.well-known/openid-configuration "), "https://idp.example.com/realms/hub");
  assert.equal(trimIssuer("https://idp.example.com/.well-known/openid-configuration/"), "https://idp.example.com");
  assert.equal(trimIssuer("https://idp.example.com/.well-known/other"), "https://idp.example.com/.well-known/other");
});

test("resolveOidc uses the settings client id and always the app callback", () => {
  const resolved = resolveOidc(
    {
      enabled: true,
      issuer: "https://idp.example.com/",
      client_id: "from-settings",
      scopes: "email groups",
    },
    {
      clientSecret: "secret",
      appUrl: "https://hub.example.com",
    },
  );
  assert.equal(resolved.issuer, "https://idp.example.com");
  assert.equal(resolved.clientId, "from-settings");
  assert.equal(resolved.redirectUrl, "https://hub.example.com/sso/callback");
  assert.equal(resolved.scopes, "openid email groups");
  assert.equal(
    oidcIsReady(
      { enabled: true, issuer: "https://idp.example.com", client_id: "id" },
      { clientSecret: "secret" },
    ),
    true,
  );
  assert.equal(
    oidcIsReady(
      { enabled: true, issuer: "https://idp.example.com", client_id: "id" },
      { clientSecret: "" },
    ),
    false,
  );
});

test("sign and verify OIDC state, reject mismatches, tampering, and expiry", () => {
  const secret = "test-secret-aaaaaaaaaaaaaaaa";
  const state = "s".repeat(43);
  const signed = signOidcState({
    returnPath: "/usage",
    state,
    nonce: "n".repeat(43),
    verifier: "v".repeat(43),
    nowSeconds: 1_000,
    secret,
  });
  assert.equal(signed.state, state);
  assert.notEqual(signed.state, signed.nonce);
  assert.deepEqual(verifyOidcState({ cookie: signed.cookie, state, nowSeconds: 1_010, secret }), {
    nonce: "n".repeat(43),
    verifier: "v".repeat(43),
    returnPath: "/usage",
  });
  assert.equal(verifyOidcState({ cookie: signed.cookie, state: "x".repeat(43), nowSeconds: 1_010, secret }), null);
  assert.equal(verifyOidcState({ cookie: signed.cookie, state, nowSeconds: 1_000 + 601, secret }), null);
  assert.equal(verifyOidcState({ cookie: signed.cookie, state, nowSeconds: 1_010, secret: `${secret}x` }), null);
  const parts = signed.cookie.split(".");
  parts[2] = "w".repeat(43);
  assert.equal(verifyOidcState({ cookie: parts.join("."), state, nowSeconds: 1_010, secret }), null);
});

test("a role check state never verifies as a sign-in state and the other way round", () => {
  const secret = "test-secret-aaaaaaaaaaaaaaaa";
  const parts = { state: "s".repeat(43), nonce: "n".repeat(43), verifier: "v".repeat(43), nowSeconds: 1_000, secret };
  const check = signOidcState({ ...parts, purpose: "role_check" });
  const signIn = signOidcState(parts);
  const at = { state: parts.state, nowSeconds: 1_010, secret };
  assert.notEqual(check.cookie, signIn.cookie);
  assert.equal(verifyOidcState({ cookie: check.cookie, ...at }), null);
  assert.equal(verifyOidcState({ cookie: signIn.cookie, ...at, purpose: "role_check" }), null);
  assert.equal(verifyOidcState({ cookie: check.cookie, ...at, purpose: "role_check" })?.nonce, parts.nonce);
  assert.equal(verifyOidcState({ cookie: signIn.cookie, ...at, purpose: "sign_in" })?.nonce, parts.nonce);
});

test("OIDC state values are random and distinct by default", () => {
  const a = signOidcState({ returnPath: "/" });
  const b = signOidcState({ returnPath: "/" });
  assert.match(a.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.state, a.nonce);
  assert.notEqual(a.verifier, a.state);
  assert.notEqual(a.state, b.state);
  assert.equal(a.codeChallenge, pkceChallenge(a.verifier));
});

test("PKCE uses the RFC 7636 S256 transform", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("buildAuthorizationUrl and token body match the OIDC code flow with PKCE", () => {
  const disc: OidcDiscovery = {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
    userinfo_endpoint: "",
    scopes_supported: [],
    token_endpoint_auth_methods_supported: [],
    id_token_signing_alg_values_supported: [],
  };
  const resolved = resolveOidc(
    { enabled: true, issuer: disc.issuer, client_id: "hub" },
    { clientSecret: "s3cret", appUrl: "https://hub.example.com" },
  );
  const url = new URL(
    buildAuthorizationUrl(disc, resolved, {
      state: "state-1",
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://idp.example.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "hub");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("nonce"), "nonce-1");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const { body, headers } = tokenRequest(resolved, "code-99", "verifier-1");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code-99");
  assert.equal(body.get("client_secret"), "s3cret");
  assert.equal(body.get("code_verifier"), "verifier-1");
  assert.equal(headers.Authorization, undefined);
  const jwt = jwtConfigForOidc(resolved, disc);
  assert.equal(jwt.jwks_url, disc.jwks_uri);
  assert.equal(jwt.audience, "hub");
});

test("emailFromOidcClaims only trusts verified email claims", () => {
  assert.equal(emailFromOidcClaims({ email: "A@Ex.com", email_verified: true }), "a@ex.com");
  assert.equal(emailFromOidcClaims({ email: "a@ex.com", email_verified: "true" }), "a@ex.com");
  assert.equal(emailFromOidcClaims({ email: "a@ex.com" }), "");
  assert.equal(emailFromOidcClaims({ email: "a@ex.com", email_verified: false }), "");
  assert.equal(emailFromOidcClaims({ preferred_username: "user@ex.com", email_verified: true }), "");
  assert.equal(emailFromOidcClaims({ sub: "owner@ex.com", email_verified: true }), "");
});

test("fetchOidcDiscovery reads well-known document", async () => {
  resetOidcCache();
  const fetchFn: typeof fetch = async (input) => {
    assert.equal(
      String(input),
      "https://idp.example.com/.well-known/openid-configuration",
    );
    return new Response(
      JSON.stringify({
        issuer: "https://idp.example.com/",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        jwks_uri: "https://idp.example.com/jwks",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const disc = await fetchOidcDiscovery("https://idp.example.com/", fetchFn);
  assert.equal(disc.issuer, "https://idp.example.com/");
  assert.equal(disc.authorization_endpoint, "https://idp.example.com/authorize");
});

const TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ENTRA_TENANT_ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function discoveryFor(issuer: string, base = "https://idp.example.com") {
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    jwks_uri: `${base}/jwks`,
  };
}

function serving(body: unknown, requested: string[] = []): typeof fetch {
  return async (input) => {
    requested.push(String(input));
    return Response.json(body);
  };
}

async function discoveryFailure(issuer: string, fetchFn: typeof fetch): Promise<OidcDiscoveryError> {
  resetOidcCache();
  const err = await fetchOidcDiscovery(issuer, fetchFn).then(
    () => null,
    (error: unknown) => error,
  );
  resetOidcCache();
  assert.ok(err instanceof OidcDiscoveryError, String(err));
  return err;
}

test("fetchOidcDiscovery refuses a document for another issuer", async () => {
  const err = await discoveryFailure(
    "https://idp.example.com",
    serving(discoveryFor("https://evil.example.com", "https://evil.example.com")),
  );
  assert.equal(err.reason, "issuer_mismatch");
  assert.equal(err.issuer, "https://evil.example.com");
  assert.match(err.message, /issuer_mismatch/);
});

test("fetchOidcDiscovery names why the discovery document could not be used", async () => {
  const unreachable = await discoveryFailure("https://idp.example.com", async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual([unreachable.reason, unreachable.status, unreachable.issuer], ["unreachable", undefined, undefined]);

  const http = await discoveryFailure("https://idp.example.com", async () => new Response("missing", { status: 404 }));
  assert.deepEqual([http.reason, http.status], ["http", 404]);

  const html = await discoveryFailure(
    "https://idp.example.com",
    async () => new Response("<html>sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  );
  assert.equal(html.reason, "not_json");
  assert.equal((await discoveryFailure("https://idp.example.com", serving(["not", "an", "object"]))).reason, "not_json");

  for (const missing of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const doc: Record<string, string> = discoveryFor("https://idp.example.com");
    delete doc[missing];
    assert.equal((await discoveryFailure("https://idp.example.com", serving(doc))).reason, "incomplete", missing);
  }
});

test("fetchOidcDiscovery strips a pasted discovery suffix before fetching", async () => {
  resetOidcCache();
  const requested: string[] = [];
  const disc = await fetchOidcDiscovery(
    "https://idp.example.com/realms/hub/.well-known/openid-configuration",
    serving(discoveryFor("https://idp.example.com/realms/hub"), requested),
  );
  resetOidcCache();
  assert.deepEqual(requested, ["https://idp.example.com/realms/hub/.well-known/openid-configuration"]);
  assert.equal(disc.issuer, "https://idp.example.com/realms/hub");
});

test("an Entra tenant domain issuer resolves to the tenant ID issuer of the same host", async () => {
  resetOidcCache();
  const configured = "https://login.microsoftonline.com/contoso.com/v2.0";
  const requested: string[] = [];
  const fetchFn = serving(discoveryFor(ENTRA_TENANT_ISSUER, "https://login.microsoftonline.com/contoso.com"), requested);
  const disc = await fetchOidcDiscovery(`${configured}/`, fetchFn);
  assert.equal(disc.issuer, ENTRA_TENANT_ISSUER);
  assert.deepEqual(requested, [`${configured}/.well-known/openid-configuration`]);
  assert.equal((await fetchOidcDiscovery(configured, fetchFn)).issuer, ENTRA_TENANT_ISSUER);
  assert.equal(requested.length, 1);
  resetOidcCache();
  const resolved = resolveOidc(
    { enabled: true, issuer: configured, client_id: "hub" },
    { clientSecret: "s3cret", appUrl: "https://hub.example.com" },
  );
  assert.equal(jwtConfigForOidc(resolved, disc).issuer, ENTRA_TENANT_ISSUER);
});

test("Entra multi-tenant, v1, foreign-host, and other-tenant answers stay rejected", async () => {
  for (const tenant of ["common", "organizations"]) {
    const err = await discoveryFailure(
      `https://login.microsoftonline.com/${tenant}/v2.0`,
      serving(discoveryFor("https://login.microsoftonline.com/{tenantid}/v2.0")),
    );
    assert.equal(err.reason, "multi_tenant", tenant);
    assert.equal(err.issuer, "https://login.microsoftonline.com/{tenantid}/v2.0");
  }
  const v1 = await discoveryFailure(
    `https://login.microsoftonline.com/${TENANT_ID}`,
    serving(discoveryFor(`https://sts.windows.net/${TENANT_ID}/`)),
  );
  assert.deepEqual([v1.reason, v1.issuer], ["issuer_mismatch", `https://sts.windows.net/${TENANT_ID}/`]);
  const mismatches = [
    ["https://login.microsoftonline.com/contoso.com/v2.0", `https://evil.example.com/${TENANT_ID}/v2.0`],
    ["https://idp.example.com/contoso.com/v2.0", `https://idp.example.com/${TENANT_ID}/v2.0`],
    ["https://login.microsoftonline.com/contoso.com/v2.0", "https://login.microsoftonline.com/fabrikam.com/v2.0"],
    ["https://login.microsoftonline.com/contoso.com/v2.0", `https://login.microsoftonline.com/${TENANT_ID}`],
    [`https://login.microsoftonline.com/${TENANT_ID}/v2.0`, "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0"],
    ["https://login.microsoftonline.com/common/v2.0", ENTRA_TENANT_ISSUER],
    ["https://login.microsoftonline.com/consumers/v2.0", ENTRA_TENANT_ISSUER],
    ["http://login.microsoftonline.com/contoso.com/v2.0", ENTRA_TENANT_ISSUER],
  ];
  for (const [configured, discovered] of mismatches) {
    const err = await discoveryFailure(configured, serving(discoveryFor(discovered)));
    assert.deepEqual([err.reason, err.issuer], ["issuer_mismatch", discovered], configured);
  }
});

test("discovery failures log the reason, status, and issuer host only", () => {
  assert.deepEqual(oidcFailureFields(new OidcDiscoveryError("http", { status: 502 })), { reason: "http", status: 502 });
  assert.deepEqual(
    oidcFailureFields(new OidcDiscoveryError("issuer_mismatch", { issuer: `https://sts.windows.net/${TENANT_ID}/` })),
    { reason: "issuer_mismatch", issuerHost: "sts.windows.net" },
  );
  assert.deepEqual(oidcFailureFields(new Error("other")), {});
});

test("issuer suggestions name the concrete issuer and the Entra v2.0 endpoint", () => {
  assert.equal(entraV2Issuer(`https://sts.windows.net/${TENANT_ID.toUpperCase()}/`), ENTRA_TENANT_ISSUER);
  assert.equal(entraV2Issuer("https://sts.windows.net/contoso.com/"), null);
  assert.equal(suggestedIssuer(`https://sts.windows.net/${TENANT_ID}/`), ENTRA_TENANT_ISSUER);
  assert.equal(suggestedIssuer("https://idp.example.com/realms/hub/"), "https://idp.example.com/realms/hub");
  assert.equal(suggestedIssuer("https://login.microsoftonline.com/{tenantid}/v2.0"), null);
  assert.equal(suggestedIssuer(""), null);
});

test("the token request uses client_secret_basic only when the provider prefers it", () => {
  assert.equal(tokenAuthMethod([]), "client_secret_post");
  assert.equal(tokenAuthMethod(["client_secret_basic"]), "client_secret_basic");
  assert.equal(tokenAuthMethod(["client_secret_post", "client_secret_basic"]), "client_secret_post");
  assert.equal(tokenAuthMethod(["client_secret_basic", "client_secret_post"]), "client_secret_basic");
  assert.equal(tokenAuthMethod(["private_key_jwt"]), "client_secret_post");
  const resolved = resolveOidc(
    { enabled: true, issuer: "https://idp.example.com", client_id: "hub app" },
    { clientSecret: "s3c:ret+", appUrl: "https://hub.example.com" },
  );
  const { body, headers } = tokenRequest(resolved, "code", "verifier", "client_secret_basic");
  assert.equal(body.get("client_secret"), null);
  assert.equal(body.get("client_id"), null);
  assert.equal(
    Buffer.from(headers.Authorization.replace(/^Basic /, ""), "base64").toString("utf8"),
    "hub+app:s3c%3Aret%2B",
  );
});

test("a refused code exchange names the provider error and its Entra error codes", async () => {
  const base = "https://login.microsoftonline.com/contoso.com";
  const configured = `${base}/v2.0`;
  let tokenAnswer: Response = new Response("", { status: 500 });
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${configured}/.well-known/openid-configuration`) {
      return Response.json(discoveryFor(ENTRA_TENANT_ISSUER, base));
    }
    if (url === `${base}/token`) return tokenAnswer;
    return new Response("unexpected", { status: 500 });
  };
  const resolved = resolveOidc(
    { enabled: true, issuer: configured, client_id: "hub" },
    { clientSecret: "s3cret", appUrl: "https://hub.example.com" },
  );
  const exchange = () => exchangeOidcCode({ resolved, code: "code-1", nonce: "nonce-1", verifier: "v".repeat(43), fetchFn });
  try {
    resetOidcCache();
    tokenAnswer = Response.json(
      { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.", error_codes: [7000215] },
      { status: 401 },
    );
    await assert.rejects(exchange(), { message: "oidc token 401 invalid_client AADSTS7000215" });
    tokenAnswer = Response.json({ error: "invalid_grant", error_codes: ["x", 1.5] }, { status: 400 });
    await assert.rejects(exchange(), { message: "oidc token 400 invalid_grant" });
    tokenAnswer = new Response("down", { status: 502 });
    await assert.rejects(exchange(), { message: "oidc token 502" });
  } finally {
    resetOidcCache();
  }
});

test("claims map to a stable identity with groups and external ids", () => {
  const identity = identityFromClaims(
    {
      iss: "https://login.microsoftonline.com/t/v2.0",
      sub: "pairwise-sub",
      oid: "object-id",
      email: "Ada@Example.com",
      xms_edov: true,
      groups: ["g1", "g2", 3, { bad: true }],
    },
    "groups",
  );
  assert.deepEqual(identity, {
    issuer: "https://login.microsoftonline.com/t/v2.0",
    subject: "pairwise-sub",
    email: "ada@example.com",
    groups: ["g1", "g2", "3"],
    appRoles: null,
    externalIds: ["pairwise-sub", "object-id"],
  });
  assert.throws(() => identityFromClaims({ iss: "x", email: "a@b.c", email_verified: true }, ""), /sub/);
  assert.deepEqual(claimValues({ realm_access: { roles: ["admin"] } }, "realm_access.roles"), ["admin"]);
  assert.deepEqual(claimValues({ "https://llmhub/roles": "ops" }, "https://llmhub/roles"), ["ops"]);
  assert.deepEqual(claimValues({ groups: "solo" }, ""), []);
  assert.equal(emailFromOidcClaims({ email: "a@ex.com", xms_edov: "true" }), "a@ex.com");
});

test("the app_roles scope is requested only when discovery offers it", async () => {
  const resolved = resolveOidc(
    { enabled: true, issuer: "https://idp.example.com", client_id: "hub", scopes: "email profile" },
    { clientSecret: "s3cret", appUrl: "https://hub.example.com" },
  );
  const disc = (scopes_supported: string[]): OidcDiscovery => ({
    ...discoveryFor("https://idp.example.com"),
    userinfo_endpoint: "",
    scopes_supported,
    token_endpoint_auth_methods_supported: [],
    id_token_signing_alg_values_supported: [],
  });
  const scopeFor = (offered: OidcDiscovery, config = resolved) =>
    new URL(buildAuthorizationUrl(offered, config, { state: "s", nonce: "n", codeChallenge: "c" })).searchParams.get("scope");
  assert.equal(scopeFor(disc([])), "openid email profile");
  assert.equal(scopeFor(disc(["openid", "email", "profile", "groups"])), "openid email profile");
  assert.equal(scopeFor(disc(["openid", "email", "app_roles"])), "openid email profile app_roles");
  const typed = { ...resolved, scopes: "openid app_roles email" };
  assert.equal(scopeFor(disc([]), typed), "openid email");
  assert.equal(scopeFor(disc(["openid", "email"]), typed), "openid email");
  assert.equal(scopeFor(disc(["app_roles"]), typed), "openid email app_roles");
  assert.equal(appRolesOffered(disc(["App_Roles"])), false);

  resetOidcCache();
  try {
    const fetched = await fetchOidcDiscovery(
      "https://idp.example.com",
      serving({ ...discoveryFor("https://idp.example.com"), scopes_supported: ["openid", "app_roles", 7] }),
    );
    assert.deepEqual(fetched.scopes_supported, ["openid", "app_roles"]);
    assert.equal(appRolesOffered(fetched), true);
  } finally {
    resetOidcCache();
  }
});

test("app roles come only from an offered app_roles list and rank by role template", () => {
  const claims = { iss: "https://id.example.com", sub: "s1", groups: ["admin"], app_roles: ["Viewer", "operator", "viewer"] };
  const offered = identityFromClaims(claims, "groups", true);
  assert.deepEqual(offered.appRoles, ["viewer", "operator"]);
  assert.deepEqual(offered.groups, ["admin"]);
  assert.deepEqual(identityFromClaims({ ...claims, app_roles: [] }, "groups", true).appRoles, []);
  assert.equal(identityFromClaims(claims, "groups", false).appRoles, null);
  assert.equal(identityFromClaims(claims, "groups").appRoles, null);
  assert.equal(identityFromClaims({ ...claims, app_roles: "admin" }, "groups", true).appRoles, null);
  assert.equal(identityFromClaims({ iss: claims.iss, sub: claims.sub }, "groups", true).appRoles, null);
  assert.deepEqual(appRoleTemplates(["viewer", "auditor", "Finance", "admin"]), ["admin", "finance", "viewer"]);
  assert.deepEqual(appRoleTemplates(["operator", "viewer"]), ["operator", "viewer"]);
  assert.deepEqual(appRoleTemplates(["auditor"]), []);
});

test("group rules pick the first matching role and domains are checked exactly", () => {
  const rules = [
    { group: "LLM-Admins", role_id: "admin" },
    { group: "llm-users", role_id: "viewer" },
  ];
  assert.equal(mappedRoleId(rules, ["llm-users", "llm-admins"]), "admin");
  assert.equal(mappedRoleId(rules, ["llm-users"]), "viewer");
  assert.equal(mappedRoleId(rules, ["other"]), null);
  assert.equal(emailDomainAllowed("a@Example.com", []), true);
  assert.equal(emailDomainAllowed("a@Example.com", ["example.com"]), true);
  assert.equal(emailDomainAllowed("a@sub.example.com", ["example.com"]), false);
  assert.equal(emailDomainAllowed("a@evilexample.com", ["example.com"]), false);
  assert.equal(oidcScopes("profile  openid email"), "openid profile email");
});

async function withJwks<T>(jwks: object, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(jwks)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function signed(alg: string, key: KeyObject, kid: string, claims: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg, kid })}.${encode(claims)}`;
  const hash = alg === "EdDSA" ? null : `sha${alg.slice(2)}`;
  const options = alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" as const } : key;
  return `${data}.${sign(hash, Buffer.from(data), options).toString("base64url")}`;
}

test("ID tokens verify with RSA, EC P-256 and P-384, and Ed25519 keys bound to their kid", async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://idp.example.com", aud: "hub", exp: now + 60 };
  const pairs = [
    { alg: "RS256", ...generateKeyPairSync("rsa", { modulusLength: 2048 }) },
    { alg: "ES256", ...generateKeyPairSync("ec", { namedCurve: "P-256" }) },
    { alg: "ES384", ...generateKeyPairSync("ec", { namedCurve: "P-384" }) },
    { alg: "EdDSA", ...generateKeyPairSync("ed25519") },
  ];
  const keys = pairs.map((pair, index) => ({ ...pair.publicKey.export({ format: "jwk" }), kid: `k${index}`, use: "sig" }));
  const cfg = { issuer: "https://idp.example.com", audience: "hub", jwks_url: `https://idp.example.com/jwks-${now}` };
  await withJwks({ keys }, async () => {
    for (const [index, pair] of pairs.entries()) {
      const token = signed(pair.alg, pair.privateKey, `k${index}`, claims);
      assert.equal((await verifyJwt(token, cfg)).iss, "https://idp.example.com", pair.alg);
    }
    const wrongKid = signed("ES256", pairs[1].privateKey, "k2", claims);
    await assert.rejects(verifyJwt(wrongKid, cfg), /jwt (signature|kid unknown)/);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    await assert.rejects(verifyJwt(none, cfg), /jwt alg/);
    const hs = signed("RS256", pairs[0].privateKey, "k0", claims).replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "HS256", kid: "k0" })).toString("base64url"));
    await assert.rejects(verifyJwt(hs, cfg), /jwt alg/);
    const otherAudience = signed("ES256", pairs[1].privateKey, "k1", { ...claims, aud: ["other", "hub"], azp: "other" });
    await assert.rejects(verifyJwt(otherAudience, cfg), /azp/);
  });
});

test("an Entra tenant domain sign-in verifies the ID token against the tenant ID issuer", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const base = "https://login.microsoftonline.com/contoso.com";
  const configured = `${base}/v2.0`;
  const jwksUrl = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys-${now}`;
  const claims = { iss: ENTRA_TENANT_ISSUER, aud: "hub", exp: now + 60, nonce: "nonce-1", sub: "subject-1" };
  const tenantToken = signed("RS256", privateKey, "k1", claims);
  const domainToken = signed("RS256", privateKey, "k1", { ...claims, iss: configured });
  let idToken = tenantToken;
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${configured}/.well-known/openid-configuration`) {
      return Response.json({ ...discoveryFor(ENTRA_TENANT_ISSUER, base), jwks_uri: jwksUrl });
    }
    if (url === jwksUrl) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] });
    if (url === `${base}/token`) return Response.json({ id_token: idToken });
    return new Response("unexpected", { status: 500 });
  };
  const resolved = resolveOidc(
    { enabled: true, issuer: configured, client_id: "hub" },
    { clientSecret: "s3cret", appUrl: "https://hub.example.com" },
  );
  const exchange = () => exchangeOidcCode({ resolved, code: "code-1", nonce: "nonce-1", verifier: "v".repeat(43), fetchFn });
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    resetOidcCache();
    const identity = await exchange();
    assert.equal(identity.issuer, ENTRA_TENANT_ISSUER);
    assert.equal(identity.subject, "subject-1");
    idToken = domainToken;
    await assert.rejects(exchange(), /jwt issuer mismatch/);
  } finally {
    globalThis.fetch = original;
    resetOidcCache();
  }
});
