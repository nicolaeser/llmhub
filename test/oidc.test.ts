import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizationUrl,
  emailFromOidcClaims,
  fetchOidcDiscovery,
  jwtConfigForOidc,
  oidcIsReady,
  pkceChallenge,
  resetOidcCache,
  resolveOidc,
  signOidcState,
  tokenRequestBody,
  trimIssuer,
  verifyOidcState,
} from "@/lib/auth/oidc";
import type { OidcDiscovery } from "@/types/auth";

test("trimIssuer drops trailing slashes", () => {
  assert.equal(trimIssuer("https://idp.example.com/"), "https://idp.example.com");
  assert.equal(trimIssuer("https://idp.example.com///"), "https://idp.example.com");
});

test("resolveOidc uses the settings client id and default callback", () => {
  const resolved = resolveOidc(
    {
      enabled: true,
      issuer: "https://idp.example.com/",
      client_id: "from-settings",
      redirect_url: "",
    },
    {
      clientSecret: "secret",
      appUrl: "https://hub.example.com",
    },
  );
  assert.equal(resolved.issuer, "https://idp.example.com");
  assert.equal(resolved.clientId, "from-settings");
  assert.equal(resolved.redirectUrl, "https://hub.example.com/sso/callback");
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
  };
  const resolved = resolveOidc(
    {
      enabled: true,
      issuer: disc.issuer,
      client_id: "hub",
      redirect_url: "https://hub.example.com/sso/callback",
    },
    { clientSecret: "s3cret" },
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
  const body = tokenRequestBody(resolved, "code-99", "verifier-1");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code-99");
  assert.equal(body.get("client_secret"), "s3cret");
  assert.equal(body.get("code_verifier"), "verifier-1");
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
  assert.equal(disc.issuer, "https://idp.example.com");
  assert.equal(disc.authorization_endpoint, "https://idp.example.com/authorize");
});
