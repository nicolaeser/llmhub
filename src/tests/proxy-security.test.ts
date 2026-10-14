import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { randomToken } from "@/lib/crypto";
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

test("pages without a valid signed session cookie redirect to login with a return path", async () => {
  const forged = `${randomToken()}.${"0".repeat(64)}`;
  for (const cookie of [undefined, "garbage", forged, randomToken()]) {
    const res = await proxy(request("/keys?tab=mine", cookie));
    assert.equal(res.status, 307);
    assert.equal(redirectTarget(res), "/account/login?return=%2Fkeys");
  }
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

test("signed-in users are sent from sign-in pages back to a safe return path", async () => {
  const cookie = await signSessionToken(randomToken());
  assert.equal(redirectTarget(await proxy(request("/account/login?return=%2Fusage", cookie))), "/usage");
  assert.equal(redirectTarget(await proxy(request("/account/login?return=https%3A%2F%2Fevil.example", cookie))), "/");
});
