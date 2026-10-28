import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/return-path";
import { randomToken } from "@/lib/crypto";
import { LOCALE_COOKIE } from "@/i18n/locale-cookie";
import { config, proxy } from "@/proxy";

const APP = "http://localhost:3000";

function request(path: string, cookie?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${APP}${path}`, {
    headers: { ...headers, ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) },
  });
}

function redirectTarget(res: Response): string | null {
  const location = res.headers.get("location");
  if (!location) return null;
  const url = new URL(location);
  return `${url.pathname}${url.search}`;
}

const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

test("the proxy matcher leaves API, gateway, SCIM, SSO, and internal routes to their own authentication", async () => {
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
  for (const path of ["/", "/keys", "/account/login", "/internal-api/setup", "/internal-api/setup/step", "/de/usage"]) {
    assert.equal(matches(path), true, path);
  }
  for (const path of [
    "/api/v1/chat/completions",
    "/api/mgmt/keys",
    "/v1/models",
    "/subscription/v1/messages",
    "/scim/v2/Users",
    "/sso/login",
    "/sso/callback",
    "/internal-api/account/logout",
    "/internal-api/health",
    "/internal-api/setupx",
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/logo.png",
  ]) {
    assert.equal(matches(path), false, path);
  }
});

test("pages without a valid signed session cookie redirect to login with the path and query and drop the cookie", async () => {
  const forged = `${randomToken()}.${"0".repeat(64)}`;
  for (const cookie of [undefined, "garbage", forged, randomToken()]) {
    const res = await proxy(request("/keys?tab=mine&_rsc=1a2b", cookie));
    assert.equal(res.status, 307);
    assert.equal(redirectTarget(res), "/account/login?return=%2Fkeys%3Ftab%3Dmine");
    const cleared = res.cookies.get(SESSION_COOKIE);
    if (cookie) {
      assert.equal(cleared?.value, "");
      assert.equal(cleared?.maxAge, 0);
    } else {
      assert.equal(cleared, undefined);
    }
  }
});

test("a signed session cookie reaches the server session check with the requested path and query", async () => {
  const cookie = await signSessionToken(randomToken());
  const res = await proxy(request("/usage?tab=keys&_rsc=1a2b", cookie, { [REQUEST_PATH_HEADER]: "//evil.example" }));
  assert.equal(passedThrough(res), true);
  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`), "/usage?tab=keys");
  assert.equal(res.cookies.get(SESSION_COOKIE), undefined);
});

test("sign-in pages and setup stay reachable without a session and never redirect to setup", async () => {
  for (const path of ["/account/login", "/account/register", "/account/forgot-password", "/internal-api/setup"]) {
    const res = await proxy(request(path));
    assert.equal(passedThrough(res), true, path);
    assert.equal(res.headers.get("location"), null, path);
  }
});

test("a signed-in locale prefix redirects to the page without the prefix", async () => {
  const cookie = await signSessionToken(randomToken());
  assert.equal(redirectTarget(await proxy(request("/en/keys?tab=templates", cookie))), "/keys?tab=templates");
  assert.equal(redirectTarget(await proxy(request("/de", cookie))), "/");
  assert.equal(redirectTarget(await proxy(request("/en/keys", cookie))), "/keys");
});

test("an unsigned locale prefix still reaches login with the real return path", async () => {
  const res = await proxy(request("/en/keys"));
  assert.equal(res.status, 307);
  assert.equal(redirectTarget(res), "/account/login?return=%2Fkeys");
});

test("a signed session cookie passes through with locale and security headers", async () => {
  const cookie = await signSessionToken(randomToken());
  const res = await proxy(request("/keys", cookie, { "accept-language": "de-DE,de;q=0.9" }));
  assert.equal(passedThrough(res), true);
  assert.equal(res.headers.get("x-middleware-request-x-next-intl-locale"), "de");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a chosen locale cookie outranks an English browser on console pages, server actions, and sign-in", async () => {
  const session = await signSessionToken(randomToken());
  const english = { "accept-language": "en-US,en;q=0.9" };
  const signedIn = `${SESSION_COOKIE}=${session}; ${LOCALE_COOKIE.name}=de`;
  const requests = [
    new NextRequest(`${APP}/keys`, { headers: { ...english, cookie: signedIn, "sec-fetch-dest": "document" } }),
    new NextRequest(`${APP}/keys?tab=templates`, {
      method: "POST",
      headers: { ...english, cookie: signedIn, "next-action": "a".repeat(42), "sec-fetch-dest": "empty" },
    }),
    new NextRequest(`${APP}/account/login`, {
      headers: { ...english, cookie: `${LOCALE_COOKIE.name}=de`, "sec-fetch-dest": "document" },
    }),
  ];
  for (const req of requests) {
    const res = await proxy(req);
    const label = `${req.method} ${req.nextUrl.pathname}`;
    assert.equal(passedThrough(res), true, label);
    assert.equal(res.headers.get("x-middleware-request-x-next-intl-locale"), "de", label);
    assert.equal(
      res.headers.getSetCookie().some((line) => line.startsWith(`${LOCALE_COOKIE.name}=`)),
      false,
      label,
    );
  }
});

test("an unsupported locale cookie falls back to the browser language", async () => {
  const session = await signSessionToken(randomToken());
  const res = await proxy(
    new NextRequest(`${APP}/keys`, {
      headers: { "accept-language": "de-DE,de;q=0.9", cookie: `${SESSION_COOKIE}=${session}; ${LOCALE_COOKIE.name}=fr` },
    }),
  );
  assert.equal(res.headers.get("x-middleware-request-x-next-intl-locale"), "de");
});

test("signed-in users are sent from sign-in pages back to a safe return path", async () => {
  const cookie = await signSessionToken(randomToken());
  assert.equal(redirectTarget(await proxy(request("/account/login?return=%2Fusage", cookie))), "/usage");
  assert.equal(redirectTarget(await proxy(request("/account/login?return=https%3A%2F%2Fevil.example", cookie))), "/");
});

const SUB_ADD_TOKEN = `${"A".repeat(20)}${"b-_9".repeat(5)}zzz`;

test("add-account link pages are public only at their exact token paths", async () => {
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
  assert.equal(SUB_ADD_TOKEN.length, 43);
  for (const path of [`/providers/sub-add/${SUB_ADD_TOKEN}`, `/providers/sub-add/manage/${SUB_ADD_TOKEN}`]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: path }), true, path);
    const res = await proxy(request(path));
    assert.equal(passedThrough(res), true, path);
    assert.equal(res.headers.get("location"), null, path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
  }
  const signedIn = await signSessionToken(randomToken());
  assert.equal(passedThrough(await proxy(request(`/providers/sub-add/${SUB_ADD_TOKEN}`, signedIn))), true);
});

test("every other providers path stays behind the console session", async () => {
  for (const path of [
    "/providers",
    "/providers?tab=subscriptions",
    "/providers/sub-add",
    "/providers/sub-add/",
    "/providers/sub-add/manage",
    "/providers/sub-add/manage/",
    "/providers/sub-add/short-token",
    `/providers/sub-add/${SUB_ADD_TOKEN}x`,
    `/providers/sub-add/${SUB_ADD_TOKEN}/extra`,
    `/providers/sub-add/manage/${SUB_ADD_TOKEN}/extra`,
    `/providers/sub-add/other/${SUB_ADD_TOKEN}`,
    `/providers/${SUB_ADD_TOKEN}`,
    `/providers/subscriptions/${SUB_ADD_TOKEN}`,
    `/keys/sub-add/${SUB_ADD_TOKEN}`,
  ]) {
    const res = await proxy(request(path));
    assert.equal(res.status, 307, path);
    assert.equal(redirectTarget(res)?.startsWith("/account/login?return="), true, path);
  }
});

test("a locale prefix in front of an add-account link keeps it public", async () => {
  const res = await proxy(request(`/de/providers/sub-add/${SUB_ADD_TOKEN}`));
  assert.equal(redirectTarget(res)?.startsWith("/account/login") ?? false, false);
});
