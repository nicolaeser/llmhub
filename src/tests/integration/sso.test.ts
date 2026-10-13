import "./support/oidc-env";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { OIDC_STATE_COOKIE } from "@/lib/auth/oidc";
import { digest, pkceChallenge, randomToken } from "@/lib/crypto";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { normalizeOidc, patchEnterprise } from "@/lib/settings/enterprise";
import { GET as ssoLogin } from "@/app/sso/login/route";
import { GET as ssoCallback } from "@/app/sso/callback/route";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting, TestData } from "./support/fixtures";

const CLIENT_ID = "hub-integration";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ecKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const provider = { basic: false, alg: "RS256" as "RS256" | "ES256" };
const issued = new Map<string, { challenge: string; nonce: string; email: string; nonceOverride?: string }>();
const tokenRequests: URLSearchParams[] = [];
let issuer = "";
let server: Server;
let restoreEnterprise: () => Promise<void>;

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  if (provider.alg === "ES256") {
    const body = `${encode({ alg: "ES256", kid: "ec" })}.${encode(claims)}`;
    const signature = sign("sha256", Buffer.from(body), { key: ecKeys.privateKey, dsaEncoding: "ieee-p1363" });
    return `${body}.${signature.toString("base64url")}`;
  }
  const body = `${encode({ alg: "RS256", kid: "it" })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  return `${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function clientCredentials(req: IncomingMessage, form: URLSearchParams) {
  if (!provider.basic) return { id: form.get("client_id"), secret: form.get("client_secret") };
  const raw = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
  const [id = "", secret = ""] = raw.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
  return form.get("client_secret") ? { id: "", secret: "" } : { id, secret };
}

function identityProvider(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", issuer);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      token_endpoint_auth_methods_supported: provider.basic
        ? ["client_secret_basic", "client_secret_post"]
        : ["client_secret_post"],
    });
  }
  if (url.pathname === "/jwks") {
    return json(200, {
      keys: [
        { ...publicKey.export({ format: "jwk" }), kid: "it", alg: "RS256", use: "sig" },
        { ...ecKeys.publicKey.export({ format: "jwk" }), kid: "ec", alg: "ES256", use: "sig" },
      ],
    });
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      tokenRequests.push(form);
      const grant = issued.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const client = clientCredentials(req, form);
      if (
        !grant ||
        client.secret !== process.env.OIDC_CLIENT_SECRET ||
        client.id !== CLIENT_ID ||
        pkceChallenge(verifier) !== grant.challenge
      ) {
        return json(400, { error: "invalid_grant" });
      }
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        id_token: idToken({
          iss: issuer,
          aud: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce: grant.nonceOverride ?? grant.nonce,
          sub: `sub-${grant.email}`,
          email: grant.email,
          email_verified: true,
        }),
      });
    });
    return;
  }
  json(404, {});
}

before(async () => {
  server = createServer(identityProvider);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  restoreEnterprise = await preserveSetting("enterprise");
  await ensureSystemCatalog();
  await patchEnterprise({ oidc: normalizeOidc({ enabled: true, issuer, client_id: CLIENT_ID }) });
});

after(async () => {
  await restoreEnterprise();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

async function signInAs(email: string, options: { sessionCookie?: string; nonceOverride?: string } = {}) {
  const started = await ssoLogin(new NextRequest("http://localhost:3000/sso/login?return=%2Fkeys%3Ftab%3Dmine"));
  const authorize = new URL(started.headers.get("location") ?? "");
  const stateCookie = started.cookies.get(OIDC_STATE_COOKIE)?.value ?? "";
  const params = authorize.searchParams;
  const code = uniqueName("code");
  issued.set(code, {
    challenge: params.get("code_challenge") ?? "",
    nonce: params.get("nonce") ?? "",
    email,
    nonceOverride: options.nonceOverride,
  });
  const cookies = [`${OIDC_STATE_COOKIE}=${stateCookie}`, ...(options.sessionCookie ? [`${SESSION_COOKIE}=${options.sessionCookie}`] : [])];
  const res = await ssoCallback(
    new NextRequest(`http://localhost:3000/sso/callback?code=${code}&state=${params.get("state")}`, {
      headers: { cookie: cookies.join("; "), "x-forwarded-for": "198.51.100.30" },
    }),
  );
  return { authorize, res, location: new URL(res.headers.get("location") ?? "") };
}

test("SSO uses an authorization code with PKCE and a state distinct from the nonce", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { authorize } = await signInAs(user.email);
    const params = authorize.searchParams;
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${issuer}/authorize`);
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("client_id"), CLIENT_ID);
    assert.equal(params.get("redirect_uri"), `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/sso/callback`);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.ok(params.get("state"));
    assert.ok(params.get("nonce"));
    assert.notEqual(params.get("state"), params.get("nonce"));
    const token = tokenRequests.at(-1);
    assert.equal(token?.get("grant_type"), "authorization_code");
    assert.equal(pkceChallenge(token?.get("code_verifier") ?? ""), params.get("code_challenge"));
  } finally {
    await data.cleanup();
  }
});

test("the SSO callback rotates the browser session and records the SSO factor", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const previousToken = randomToken();
    const previous = await prisma.session.create({
      data: { userId: user.id, tokenHash: digest(previousToken), secondFactor: "TOTP", expiresAt: new Date(Date.now() + 86_400_000) },
    });

    const { res, location } = await signInAs(user.email, { sessionCookie: await signSessionToken(previousToken) });

    assert.equal(`${location.pathname}${location.search}`, "/keys?tab=mine");
    assert.equal(await prisma.session.count({ where: { id: previous.id } }), 0);
    const cookie = res.cookies.get(SESSION_COOKIE)?.value ?? "";
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].tokenHash, digest(cookie.split(".")[0]));
    assert.equal(sessions[0].secondFactor, "SSO");
    assert.equal(sessions[0].ipAddress, "198.51.100.30");
    assert.equal(res.cookies.get(OIDC_STATE_COOKIE)?.value, "");
  } finally {
    await data.cleanup();
  }
});

test("SSO creates viewer accounts on first sign-in and never signs in the owner", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    const owner = await data.user({ isOwner: true });
    const created = await signInAs(email);
    assert.equal(created.location.pathname, "/keys");
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
    data.ownUser(user.id);
    assert.equal(user.role?.templateKey, "viewer");
    assert.equal(user.isOwner, false);

    const refused = await signInAs(owner.email);
    assert.equal(refused.location.searchParams.get("sso"), "owner");
    assert.equal(refused.res.cookies.get(SESSION_COOKIE), undefined);
    assert.equal(await prisma.session.count({ where: { userId: owner.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("an ID token for another nonce or a blocked user does not start a session", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const replayed = await signInAs(user.email, { nonceOverride: "a-nonce-from-another-sign-in" });
    assert.equal(replayed.location.searchParams.get("sso"), "error");

    await prisma.user.update({ where: { id: user.id }, data: { blocked: true } });
    const blocked = await signInAs(user.email);
    assert.equal(blocked.location.searchParams.get("sso"), "blocked");
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("SSO accepts ES256 ID tokens and client_secret_basic and stores the identity link", async () => {
  const data = new TestData();
  provider.basic = true;
  provider.alg = "ES256";
  const { resetOidcCache } = await import("@/lib/auth/oidc");
  resetOidcCache();
  try {
    const user = await data.user();
    const { location } = await signInAs(user.email);
    assert.equal(location.pathname, "/keys");
    const token = tokenRequests.at(-1);
    assert.equal(token?.get("client_secret"), null);
    const link = await prisma.userIdentity.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(link.issuer, issuer);
    assert.equal(link.subject, `sub-${user.email}`);
  } finally {
    provider.basic = false;
    provider.alg = "RS256";
    resetOidcCache();
    await data.cleanup();
  }
});
