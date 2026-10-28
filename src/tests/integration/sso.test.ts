import "./support/oidc-env";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import type { AuthenticatedSession } from "@/types/auth";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { startAppRolesCheck, readAppRolesCheck } from "@/lib/auth/app-roles-check";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { OIDC_STATE_COOKIE, resetOidcCache } from "@/lib/auth/oidc";
import { digest, pkceChallenge, randomToken } from "@/lib/crypto";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { normalizeOidc, patchEnterprise } from "@/lib/settings/enterprise";
import { saveSignInSettings, setAppRolesMode } from "@/lib/settings/sign-in";
import { GET as ssoLogin } from "@/app/sso/login/route";
import { GET as ssoCallback } from "@/app/sso/callback/route";
import { POST as backchannelLogoutRoute } from "@/app/sso/backchannel-logout/route";
import { getSession } from "@/lib/auth/session";
import { revalidateSsoSessions, SSO_REVALIDATE_INTERVAL_MS, SSO_UNVERIFIED_LIMIT_MS } from "@/lib/auth/sso-sessions";
import { restoreOwnCredentials } from "@/lib/auth/credentials";
import { restoreUserCredentials, usersConsole } from "@/lib/auth/users";
import { authenticateBearer } from "@/lib/gateway/access/principal";
import { mintTryBearer } from "@/lib/gateway/access/try-bearer";
import { authenticateManagementKey } from "@/lib/management/auth";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting, sessionOf, TestData } from "./support/fixtures";

const CLIENT_ID = "hub-integration";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ecKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const provider = {
  basic: false,
  alg: "RS256" as "RS256" | "ES256",
  offersAppRoles: false,
  appRoles: null as string[] | null,
  refreshAnswer: "valid" as "valid" | "unavailable" | "rate_limited",
};
const issued = new Map<
  string,
  { challenge: string; nonce: string; email: string; nonceOverride?: string; scope?: string; sid?: string }
>();
const refreshGrants = new Map<string, { email: string; sid: string }>();
const tokenRequests: URLSearchParams[] = [];
let issuer = "";
let server: Server;
let restoreEnterprise: () => Promise<void>;
let restoreRoleCheck: () => Promise<void>;

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

function refreshAnswer(form: URLSearchParams) {
  const grant = refreshGrants.get(form.get("refresh_token") ?? "");
  if (provider.refreshAnswer === "unavailable") return { status: 503, body: { error: "temporarily_unavailable" } };
  if (provider.refreshAnswer === "rate_limited") return { status: 429, body: { error: "slow_down" } };
  if (!grant) return { status: 400, body: { error: "invalid_grant" } };
  refreshGrants.delete(form.get("refresh_token") ?? "");
  const rotated = uniqueName("refresh");
  refreshGrants.set(rotated, grant);
  const now = Math.floor(Date.now() / 1000);
  return {
    status: 200,
    body: {
      id_token: idToken({
        iss: issuer,
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now,
        sub: `sub-${grant.email}`,
        sid: grant.sid,
        ...(provider.appRoles ? { app_roles: provider.appRoles } : {}),
      }),
      refresh_token: rotated,
    },
  };
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
      ...(provider.offersAppRoles
        ? { scopes_supported: ["openid", "email", "profile", "app_roles", "offline_access"], backchannel_logout_supported: true }
        : {}),
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
      if (form.get("grant_type") === "refresh_token") {
        const answer = refreshAnswer(form);
        return json(answer.status, answer.body);
      }
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
      const sid = grant.sid ?? uniqueName("sid");
      const offline = (grant.scope ?? "").split(" ").includes("offline_access");
      const refreshToken = offline ? uniqueName("refresh") : "";
      if (refreshToken) refreshGrants.set(refreshToken, { email: grant.email, sid });
      return json(200, {
        id_token: idToken({
          iss: issuer,
          aud: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce: grant.nonceOverride ?? grant.nonce,
          sub: `sub-${grant.email}`,
          sid,
          email: grant.email,
          email_verified: true,
          ...(provider.appRoles ? { app_roles: provider.appRoles } : {}),
        }),
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
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
  restoreRoleCheck = await preserveSetting("app_roles_check");
  await ensureSystemCatalog();
  await patchEnterprise({ oidc: normalizeOidc({ enabled: true, issuer, client_id: CLIENT_ID }) });
});

after(async () => {
  await restoreEnterprise();
  await restoreRoleCheck();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
});

async function signInAs(email: string, options: { sessionCookie?: string; nonceOverride?: string; sid?: string } = {}) {
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
    scope: params.get("scope") ?? "",
    sid: options.sid,
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

async function withProviderRoles(mode: boolean) {
  await patchEnterprise({ oidc: normalizeOidc({ enabled: true, issuer, client_id: CLIENT_ID, app_roles: mode }) });
}

async function startCheckAs(session: AuthenticatedSession, email: string) {
  const { authorize, checkCookie } = await runAsPrincipal(session, async () => {
    const { url } = await startAppRolesCheck();
    return { authorize: new URL(url), checkCookie: (await cookies()).get(OIDC_STATE_COOKIE)?.value ?? "" };
  });
  const code = uniqueName("code");
  issued.set(code, {
    challenge: authorize.searchParams.get("code_challenge") ?? "",
    nonce: authorize.searchParams.get("nonce") ?? "",
    email,
  });
  const callback = new NextRequest(
    `http://localhost:3000/sso/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie: `${OIDC_STATE_COOKIE}=${checkCookie}` } },
  );
  return { authorize, callback };
}

async function checkAs(session: AuthenticatedSession, email: string) {
  return runAsPrincipal(session, async () => {
    const { url } = await startAppRolesCheck();
    const authorize = new URL(url);
    const checkCookie = (await cookies()).get(OIDC_STATE_COOKIE)?.value ?? "";
    const code = uniqueName("code");
    issued.set(code, {
      challenge: authorize.searchParams.get("code_challenge") ?? "",
      nonce: authorize.searchParams.get("nonce") ?? "",
      email,
    });
    const res = await ssoCallback(
      new NextRequest(`http://localhost:3000/sso/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
        headers: { cookie: `${OIDC_STATE_COOKIE}=${checkCookie}` },
      }),
    );
    return { authorize, res, location: new URL(res.headers.get("location") ?? "") };
  });
}

test("an upgraded installation keeps everyone signed in with their role when the provider starts offering app roles", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  const templateOf = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true } })).role?.templateKey;
  try {
    await data.user();
    provider.appRoles = ["finance"];
    resetOidcCache();
    const unoffered = await signInAs(email);
    assert.equal(unoffered.authorize.searchParams.get("scope"), "openid email profile");
    data.ownUser((await prisma.user.findUniqueOrThrow({ where: { email } })).id);
    assert.equal(await templateOf(), "viewer");

    provider.offersAppRoles = true;
    provider.appRoles = [];
    resetOidcCache();
    const offered = await signInAs(email);
    assert.equal(offered.authorize.searchParams.get("scope"), "openid email profile app_roles");
    assert.equal(offered.location.pathname, "/keys");
    assert.ok(offered.res.cookies.get(SESSION_COOKIE)?.value);
    assert.equal(await templateOf(), "viewer");
  } finally {
    provider.offersAppRoles = false;
    provider.appRoles = null;
    resetOidcCache();
    await data.cleanup();
  }
});

test("with roles from the provider, sign-in follows the app_roles claim and refuses people without a role", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  const templateOf = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true } })).role?.templateKey;
  try {
    await data.user();
    await withProviderRoles(true);
    provider.offersAppRoles = true;
    provider.appRoles = ["finance"];
    resetOidcCache();
    const first = await signInAs(email);
    assert.equal(first.location.pathname, "/keys");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    data.ownUser(user.id);
    assert.equal(await templateOf(), "finance");

    provider.appRoles = ["viewer", "admin"];
    await signInAs(email);
    assert.equal(await templateOf(), "admin");
    assert.ok(await prisma.session.count({ where: { userId: user.id } }));

    provider.appRoles = [];
    const refused = await signInAs(email);
    assert.equal(refused.location.searchParams.get("sso"), "no_role");
    assert.equal(refused.res.cookies.get(SESSION_COOKIE), undefined);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await templateOf(), "admin");
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    provider.appRoles = null;
    resetOidcCache();
    await data.cleanup();
  }
});

test("roles from the provider turn on only after a check sign-in whose app roles contain admin", async () => {
  const data = new TestData();
  const checker = `${uniqueName("checker")}@example.test`;
  try {
    const owner = await data.user({ isOwner: true });
    const session = sessionOf(owner, { owner: true });
    await withProviderRoles(false);
    provider.offersAppRoles = true;
    resetOidcCache();
    const turnOn = () => runAsPrincipal(session, () => setAppRolesMode({ on: true }));
    await assert.rejects(turnOn(), { message: "APP_ROLES_CHECK_REQUIRED" });

    provider.appRoles = ["viewer"];
    const viewerCheck = await checkAs(session, checker);
    assert.equal(viewerCheck.authorize.searchParams.get("scope"), "openid email profile app_roles");
    assert.equal(`${viewerCheck.location.pathname}${viewerCheck.location.search}`, "/settings?tab=sign-in");
    assert.equal(viewerCheck.res.cookies.get(SESSION_COOKIE), undefined);
    assert.equal((await readAppRolesCheck(owner.id, issuer))?.result, "no_admin");
    await assert.rejects(turnOn(), { message: "APP_ROLES_CHECK_REQUIRED" });

    provider.appRoles = ["admin"];
    await checkAs(session, checker);
    assert.deepEqual(await readAppRolesCheck(owner.id, issuer).then((check) => [check?.result, check?.email]), [
      "admin",
      checker,
    ]);
    assert.equal((await turnOn()).oidc.app_roles, true);
    assert.equal((await runAsPrincipal(session, () => setAppRolesMode({ on: false }))).oidc.app_roles, false);
    assert.equal(await prisma.user.count({ where: { email: checker } }), 0);
    assert.equal(await prisma.userIdentity.count({ where: { issuer } }), 0);
    const audits = await prisma.gatewayAuditLog.findMany({
      where: { actor: owner.id, action: "settings.app_roles_mode" },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      audits.map((row) => JSON.parse(row.afterJson)),
      [{ app_roles: true }, { app_roles: false }],
    );
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    provider.appRoles = null;
    resetOidcCache();
    await data.cleanup();
  }
});

test("a new sign-in configuration takes its roles from the provider when it offers app roles", async () => {
  const data = new TestData();
  try {
    const owner = await data.user({ isOwner: true });
    const session = sessionOf(owner, { owner: true });
    provider.offersAppRoles = true;
    resetOidcCache();
    const form = (touched: boolean) => ({
      ...normalizeOidc({ enabled: true, issuer, client_id: CLIENT_ID }),
      role_fields_touched: touched,
    });
    const save = (touched: boolean) => runAsPrincipal(session, () => saveSignInSettings(form(touched)));

    await patchEnterprise({ oidc: normalizeOidc({}) });
    assert.equal((await save(true)).oidc.app_roles, false);
    await patchEnterprise({ oidc: normalizeOidc({}) });
    assert.equal((await save(false)).oidc.app_roles, true);

    await withProviderRoles(false);
    assert.equal((await save(false)).oidc.app_roles, false);
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    resetOidcCache();
    await data.cleanup();
  }
});

test("a role check finished without the admin's session or by a viewer never exchanges the code", async () => {
  const data = new TestData();
  const checker = `${uniqueName("checker")}@example.test`;
  try {
    const owner = await data.user({ isOwner: true });
    const viewerUser = await data.user();
    const owned = sessionOf(owner, { owner: true });
    const viewer = sessionOf(viewerUser, { permissions: ["settings:read"] });
    await withProviderRoles(false);
    provider.offersAppRoles = true;
    provider.appRoles = ["admin"];
    resetOidcCache();
    const before = tokenRequests.length;
    const signedOut = await startCheckAs(owned, checker);
    const asNobody = await ssoCallback(signedOut.callback);
    assert.equal(new URL(asNobody.headers.get("location") ?? "").pathname, "/account/login");
    const asViewer = await startCheckAs(owned, checker);
    const viewerRes = await runAsPrincipal(viewer, () => ssoCallback(asViewer.callback));
    assert.equal(new URL(viewerRes.headers.get("location") ?? "").pathname, "/account/login");
    assert.equal(tokenRequests.length, before);
    assert.equal(await readAppRolesCheck(owner.id, issuer), null);
    assert.equal(await readAppRolesCheck(viewerUser.id, issuer), null);
    assert.equal(await prisma.user.count({ where: { email: checker } }), 0);
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    provider.appRoles = null;
    resetOidcCache();
    await data.cleanup();
  }
});

test("a sign-in state completed by a settings manager signs in normally and records no check", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    const owner = await data.user({ isOwner: true });
    await withProviderRoles(false);
    provider.offersAppRoles = true;
    provider.appRoles = ["admin"];
    resetOidcCache();
    const { location, res } = await runAsPrincipal(sessionOf(owner, { owner: true }), () => signInAs(email));
    assert.equal(location.pathname, "/keys");
    assert.ok(res.cookies.get(SESSION_COOKIE)?.value);
    data.ownUser((await prisma.user.findUniqueOrThrow({ where: { email } })).id);
    assert.equal(await readAppRolesCheck(owner.id, issuer), null);
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    provider.appRoles = null;
    resetOidcCache();
    await data.cleanup();
  }
});

function logoutToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return idToken({
    iss: issuer,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 120,
    jti: uniqueName("jti"),
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    ...claims,
  });
}

function backchannel(token: string) {
  return backchannelLogoutRoute(
    new NextRequest("http://localhost:3000/sso/backchannel-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: token }).toString(),
    }),
  );
}

const afterInterval = () => new Date(Date.now() + SSO_REVALIDATE_INTERVAL_MS + 60_000);

async function withRolesFromProvider<T>(roles: string[], run: () => Promise<T>): Promise<T> {
  await withProviderRoles(true);
  provider.offersAppRoles = true;
  provider.appRoles = roles;
  resetOidcCache();
  try {
    return await run();
  } finally {
    await withProviderRoles(false);
    provider.offersAppRoles = false;
    provider.appRoles = null;
    provider.refreshAnswer = "valid";
    resetOidcCache();
  }
}

test("back-channel logout ends the sessions of that provider session or subject only", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  const sidFirst = uniqueName("sid-first");
  const sidSecond = uniqueName("sid-second");
  try {
    await data.user();
    const first = await signInAs(email, { sid: sidFirst });
    assert.equal(first.authorize.searchParams.get("scope"), "openid email profile");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    data.ownUser(user.id);
    await signInAs(email, { sid: sidSecond });
    const sessions = () => prisma.session.count({ where: { userId: user.id } });
    assert.equal(await sessions(), 2);
    const links = await prisma.ssoSession.findMany({ where: { session: { userId: user.id } } });
    assert.deepEqual(links.map((link) => [link.sid, link.subject, link.refreshToken]).sort(), [
      [sidFirst, `sub-${email}`, null],
      [sidSecond, `sub-${email}`, null],
    ].sort());

    const forged = logoutToken({ sub: `sub-${email}` }).split(".");
    forged[2] = forged[2].split("").reverse().join("");
    for (const bad of [
      logoutToken({ sub: `sub-${email}`, aud: "another-client" }),
      logoutToken({ sub: `sub-${email}`, events: {} }),
      logoutToken({ sub: `sub-${email}`, nonce: "nonce-1" }),
      logoutToken({ sub: `sub-${email}`, jti: "" }),
      logoutToken({}),
      forged.join("."),
      "not-a-token",
    ]) {
      const res = await backchannel(bad);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(await sessions(), 2);

    const bySid = await backchannel(logoutToken({ sid: sidFirst }));
    assert.equal(bySid.status, 200);
    assert.equal(await sessions(), 1);
    assert.equal((await prisma.ssoSession.findFirstOrThrow({ where: { session: { userId: user.id } } })).sid, sidSecond);

    assert.equal((await backchannel(logoutToken({ sub: `sub-${email}` }))).status, 200);
    assert.equal(await sessions(), 0);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id, action: "sessions.revoked" } }), 2);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, user.roleId);
  } finally {
    await data.cleanup();
  }
});

test("revalidation ends access and clears the role when the provider refuses the refresh token", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      const signedIn = await signInAs(email);
      assert.equal(signedIn.authorize.searchParams.get("scope"), "openid email profile app_roles offline_access");
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
      data.ownUser(user.id);
      assert.equal(user.role?.templateKey, "admin");
      const link = await prisma.ssoSession.findFirstOrThrow({ where: { session: { userId: user.id } } });
      assert.ok(link.refreshToken);
      assert.equal(await revalidateSsoSessions(new Date()), 0);

      refreshGrants.clear();
      assert.equal(await revalidateSsoSessions(afterInterval()), 1);
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, null);
      const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
        where: { objectId: user.id, action: "user.role_synced", afterJson: JSON.stringify({ roleId: null }) },
      });
      assert.equal(audit.actor, "sso");
    });
  } finally {
    await data.cleanup();
  }
});

test("revalidation ends access when the provider sends no known app role anymore", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    await data.user();
    await withRolesFromProvider(["operator"], async () => {
      await signInAs(email);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      provider.appRoles = [];
      assert.equal(await revalidateSsoSessions(afterInterval()), 1);
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, null);
    });
  } finally {
    await data.cleanup();
  }
});

test("a demotion found at revalidation takes effect on the next request", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  const jar = await cookies();
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      const signedIn = await signInAs(email);
      data.ownUser((await prisma.user.findUniqueOrThrow({ where: { email } })).id);
      jar.set(SESSION_COOKIE, signedIn.res.cookies.get(SESSION_COOKIE)?.value ?? "");
      const before = await getSession();
      assert.ok(!before.error && before.permissions.includes("settings:manage"));

      provider.appRoles = ["viewer"];
      assert.equal(await revalidateSsoSessions(afterInterval()), 0);
      const after = await getSession();
      assert.ok(!after.error);
      assert.equal(after.permissions.includes("settings:manage"), false);
      assert.equal(after.permissions.includes("settings:read"), true);
      assert.equal(after.role?.templateKey, "viewer");
    });
  } finally {
    jar.delete(SESSION_COOKIE);
    await data.cleanup();
  }
});

test("an unreachable provider keeps the session and checks again later", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      await signInAs(email);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      provider.refreshAnswer = "unavailable";
      const at = afterInterval();
      const lines = await capturedWarnings(() => revalidateSsoSessions(at));
      assert.equal(lines.result, 0);
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 1);
      const link = await prisma.ssoSession.findFirstOrThrow({ where: { session: { userId: user.id } } });
      assert.equal(link.checkedAt.getTime(), at.getTime());
      assert.ok(lines.events.includes("sso.revalidate_failed"));
    });
  } finally {
    await data.cleanup();
  }
});

async function capturedWarnings<T>(run: () => Promise<T>): Promise<{ result: T; events: string[] }> {
  const events: string[] = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  const keep = (line: unknown) => {
    const event = (JSON.parse(String(line)) as { event?: string }).event;
    if (event) events.push(event);
  };
  console.error = keep;
  console.log = keep;
  console.warn = keep;
  try {
    return { result: await run(), events };
  } finally {
    Object.assign(console, original);
  }
}

async function personalCredentials(userId: string) {
  const virtualKey = uniqueName("sk-hub-person");
  const managementKey = `sk-mgmt-${uniqueName("person")}`;
  await prisma.virtualKey.create({
    data: { userId, hash: digest(virtualKey), prefix: virtualKey.slice(-8), keyAlias: uniqueName("key") },
  });
  await prisma.managementKey.create({
    data: { userId, name: "automation", prefix: managementKey.slice(0, 12), hash: digest(managementKey), permissions: ["keys:read"] },
  });
  return async () => {
    const results = await Promise.allSettled([
      authenticateBearer(virtualKey),
      authenticateManagementKey(
        new Request("http://localhost:3000/api/mgmt/keys", { headers: { authorization: `Bearer ${managementKey}` } }),
      ),
      authenticateBearer(mintTryBearer(userId)),
    ]);
    return results.map((result) => result.status === "fulfilled");
  };
}

const ALL_ACCEPTED = [true, true, true];
const ALL_REFUSED = [false, false, false];

async function suspendedAt(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credentialsSuspendedAt;
}

test("access removed at the identity provider disables personal keys until the person signs in again with a role", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  const jar = await cookies();
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      await signInAs(email);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      const accepted = await personalCredentials(user.id);
      assert.deepEqual(await accepted(), ALL_ACCEPTED);

      refreshGrants.clear();
      assert.equal(await revalidateSsoSessions(afterInterval()), 1);
      assert.ok(await suspendedAt(user.id));
      assert.deepEqual(await accepted(), ALL_REFUSED);
      assert.equal(await prisma.virtualKey.count({ where: { userId: user.id, blocked: false } }), 1);
      assert.equal(await prisma.managementKey.count({ where: { userId: user.id } }), 1);
      const event = await prisma.userSecurityEvent.findFirstOrThrow({
        where: { userId: user.id, action: "credentials.suspended" },
      });
      assert.equal(event.actor, "sso");
      await prisma.gatewayAuditLog.findFirstOrThrow({ where: { objectId: user.id, action: "user.credentials_suspended", actor: "sso" } });
      await assert.rejects(restoreOwnCredentials(sessionOf(user)), { code: "FORBIDDEN" });

      provider.appRoles = [];
      const refused = await signInAs(email);
      assert.equal(refused.location.searchParams.get("sso"), "no_role");
      assert.deepEqual(await accepted(), ALL_REFUSED);

      provider.appRoles = ["admin"];
      const again = await signInAs(email);
      jar.set(SESSION_COOKIE, again.res.cookies.get(SESSION_COOKIE)?.value ?? "");
      const session = await getSession();
      assert.ok(!session.error && session.role?.templateKey === "admin");
      assert.ok(await suspendedAt(user.id));
      assert.deepEqual(await accepted(), ALL_REFUSED);

      await restoreOwnCredentials(session);
      assert.equal(await suspendedAt(user.id), null);
      assert.deepEqual(await accepted(), ALL_ACCEPTED);
      const restored = await prisma.userSecurityEvent.findFirstOrThrow({
        where: { userId: user.id, action: "credentials.restored" },
      });
      assert.equal(restored.actor, `user:${user.id}`);
    });
  } finally {
    jar.delete(SESSION_COOKIE);
    await data.cleanup();
  }
});

test("an administrator enables disabled keys again only through the explicit action", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    const manager = await data.user();
    const managing = sessionOf(manager, { permissions: ["users:read", "users:manage"] });
    await withRolesFromProvider(["operator"], async () => {
      await signInAs(email);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      const accepted = await personalCredentials(user.id);
      provider.appRoles = [];
      assert.equal(await revalidateSsoSessions(afterInterval()), 1);
      assert.deepEqual(await accepted(), ALL_REFUSED);
      const listed = (await usersConsole(managing)).users.find((row) => row.id === user.id);
      assert.equal(listed?.credentialsSuspended, true);

      await restoreUserCredentials(managing, user.id);
      assert.equal(await suspendedAt(user.id), null);
      assert.deepEqual(await accepted(), [true, true, false]);
      const event = await prisma.userSecurityEvent.findFirstOrThrow({
        where: { userId: user.id, action: "credentials.restored" },
      });
      assert.equal(event.actor, `user:${manager.id}`);
      await prisma.gatewayAuditLog.findFirstOrThrow({
        where: { objectId: user.id, action: "user.credentials_restored", actor: manager.id },
      });
    });
  } finally {
    await data.cleanup();
  }
});

test("back-channel logout disables keys only when the identity provider no longer grants access", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      const sid = uniqueName("sid");
      await signInAs(email, { sid });
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      const accepted = await personalCredentials(user.id);
      const sessions = () => prisma.session.count({ where: { userId: user.id } });

      assert.equal((await backchannel(logoutToken({ sid }))).status, 200);
      assert.equal(await sessions(), 0);
      assert.equal(await suspendedAt(user.id), null);
      assert.deepEqual(await accepted(), ALL_ACCEPTED);

      await signInAs(email);
      provider.refreshAnswer = "unavailable";
      const outage = await capturedWarnings(() => backchannel(logoutToken({ sub: `sub-${email}` })));
      assert.equal(outage.result.status, 200);
      assert.ok(outage.events.includes("sso.logout_check_failed"));
      assert.equal(await sessions(), 0);
      assert.equal(await suspendedAt(user.id), null);

      provider.refreshAnswer = "valid";
      await signInAs(email);
      provider.appRoles = [];
      assert.equal((await backchannel(logoutToken({ sub: `sub-${email}` }))).status, 200);
      assert.equal(await sessions(), 0);
      assert.ok(await suspendedAt(user.id));
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId, null);
      assert.deepEqual(await accepted(), ALL_REFUSED);

      await prisma.user.update({ where: { id: user.id }, data: { credentialsSuspendedAt: null } });
      provider.appRoles = ["admin"];
      await signInAs(email);
      refreshGrants.clear();
      assert.equal((await backchannel(logoutToken({ sub: `sub-${email}` }))).status, 200);
      assert.ok(await suspendedAt(user.id));
      assert.deepEqual(await accepted(), ALL_REFUSED);
    });
  } finally {
    await data.cleanup();
  }
});

test("24 hours without a successful check end the session while shorter outages keep it", async () => {
  const data = new TestData();
  const email = `${uniqueName("sso")}@example.test`;
  try {
    await data.user();
    await withRolesFromProvider(["admin"], async () => {
      await signInAs(email);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      data.ownUser(user.id);
      const accepted = await personalCredentials(user.id);
      const sessions = () => prisma.session.count({ where: { userId: user.id } });
      const link = await prisma.ssoSession.findFirstOrThrow({ where: { session: { userId: user.id } } });
      const start = link.validatedAt.getTime();
      const at = (ms: number) => new Date(start + ms);

      provider.refreshAnswer = "rate_limited";
      assert.equal((await capturedWarnings(() => revalidateSsoSessions(at(SSO_UNVERIFIED_LIMIT_MS / 2)))).result, 0);
      provider.refreshAnswer = "unavailable";
      assert.equal((await capturedWarnings(() => revalidateSsoSessions(at(SSO_UNVERIFIED_LIMIT_MS - 60_000)))).result, 0);
      assert.equal(await sessions(), 1);

      provider.refreshAnswer = "valid";
      const checked = at(SSO_UNVERIFIED_LIMIT_MS - 30_000 + SSO_REVALIDATE_INTERVAL_MS);
      assert.equal(await revalidateSsoSessions(checked), 0);
      const validated = await prisma.ssoSession.findFirstOrThrow({ where: { session: { userId: user.id } } });
      assert.equal(validated.validatedAt.getTime(), checked.getTime());

      provider.refreshAnswer = "unavailable";
      const later = (ms: number) => new Date(checked.getTime() + ms);
      assert.equal((await capturedWarnings(() => revalidateSsoSessions(later(SSO_UNVERIFIED_LIMIT_MS - 10 * 60_000)))).result, 0);
      assert.equal(await sessions(), 1);
      assert.equal((await capturedWarnings(() => revalidateSsoSessions(later(SSO_UNVERIFIED_LIMIT_MS)))).result, 1);
      assert.equal(await sessions(), 0);

      const event = await prisma.userSecurityEvent.findFirstOrThrow({ where: { userId: user.id, action: "sessions.unverified" } });
      assert.equal(event.actor, "sso");
      await prisma.gatewayAuditLog.findFirstOrThrow({ where: { objectId: user.id, action: "user.session_unverified", actor: "sso" } });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { role: true } });
      assert.equal(after.role?.templateKey, "admin");
      assert.equal(after.credentialsSuspendedAt, null);
      assert.deepEqual(await accepted(), ALL_ACCEPTED);
    });
  } finally {
    await data.cleanup();
  }
});
