import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizationUrl,
  emailFromOidcClaims,
  fetchOidcDiscovery,
  jwtConfigForOidc,
  oidcIsReady,
  resetOidcCache,
  resolveOidc,
  signOidcState,
  claimValues,
  identityFromClaims,
  tokenAuthMethod,
  tokenRequest,
  trimIssuer,
  verifyOidcState,
} from "@/lib/auth/oidc";
import { verifyJwt } from "@/lib/auth/jwks";
import { emailDomainAllowed, mappedRoleId, oidcScopes } from "@/lib/auth/oidc-presets";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { pkceChallenge } from "@/lib/crypto";
import type { OidcDiscovery } from "@/types/auth";

test("trimIssuer drops trailing slashes", () => {
  assert.equal(trimIssuer("https://idp.example.com/"), "https://idp.example.com");
  assert.equal(trimIssuer("https://idp.example.com///"), "https://idp.example.com");
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

test("fetchOidcDiscovery refuses a document for another issuer", async () => {
  resetOidcCache();
  const fetchFn: typeof fetch = async () =>
    Response.json({
      issuer: "https://evil.example.com",
      authorization_endpoint: "https://evil.example.com/authorize",
      token_endpoint: "https://evil.example.com/token",
      jwks_uri: "https://evil.example.com/jwks",
    });
  await assert.rejects(fetchOidcDiscovery("https://idp.example.com", fetchFn), /issuer mismatch/);
  resetOidcCache();
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
    externalIds: ["pairwise-sub", "object-id"],
  });
  assert.throws(() => identityFromClaims({ iss: "x", email: "a@b.c", email_verified: true }, ""), /sub/);
  assert.deepEqual(claimValues({ realm_access: { roles: ["admin"] } }, "realm_access.roles"), ["admin"]);
  assert.deepEqual(claimValues({ "https://llmhub/roles": "ops" }, "https://llmhub/roles"), ["ops"]);
  assert.deepEqual(claimValues({ groups: "solo" }, ""), []);
  assert.equal(emailFromOidcClaims({ email: "a@ex.com", xms_edov: "true" }), "a@ex.com");
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
