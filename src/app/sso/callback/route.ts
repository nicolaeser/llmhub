import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";
import { createSession, revokeSessionCookie } from "@/lib/auth/session";
import {
  OIDC_STATE_COOKIE,
  exchangeOidcCode,
  oidcIsReady,
  oidcStateCookieOptions,
  resolveOidc,
  verifyOidcState,
} from "@/lib/auth/oidc";
import { sanitizeReturnPath } from "@/lib/auth/return-path";
import { signInWithSso, SsoError } from "@/lib/auth/sso-user";
import { SetupRequiredError } from "@/lib/bootstrap/operators";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import { clientIp } from "@/lib/http/client-ip";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";

function clearOidcCookie(res: NextResponse) {
  const opts = oidcStateCookieOptions(0);
  res.cookies.set(opts.name, "", opts);
}

export async function GET(req: NextRequest) {
  const loginError = new URL("/account/login", req.url);
  loginError.searchParams.set("sso", "error");
  const fail = () => {
    const res = NextResponse.redirect(loginError);
    clearOidcCookie(res);
    return res;
  };

  try {
    if (req.nextUrl.searchParams.get("error")) return fail();
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const cookie = req.cookies.get(OIDC_STATE_COOKIE)?.value ?? "";
    if (!code || !state || !cookie) return fail();

    const verified = verifyOidcState({ cookie, state });
    if (!verified) return fail();

    const enterprise = await getEnterprise();
    if (!oidcIsReady(enterprise.oidc)) return fail();
    const resolved = resolveOidc(enterprise.oidc);
    const identity = await exchangeOidcCode({
      resolved,
      code,
      nonce: verified.nonce,
      verifier: verified.verifier,
    });
    const user = await signInWithSso(identity, normalizeOidc(enterprise.oidc), clientIp(req.headers));
    if (user.blocked) {
      loginError.searchParams.set("sso", "blocked");
      const res = NextResponse.redirect(loginError);
      clearOidcCookie(res);
      return res;
    }

    await revokeSessionCookie(req.cookies.get(SESSION_COOKIE)?.value);
    const session = await createSession(user.id, "SSO", {
      ipAddress: clientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    });
    const dest = sanitizeReturnPath(verified.returnPath) ?? "/";
    const res = NextResponse.redirect(new URL(dest, req.url));
    const opts = sessionCookieOptions(session.expiresAt);
    res.cookies.set(opts.name, session.cookie, opts);
    clearOidcCookie(res);
    return res;
  } catch (err) {
    if (err instanceof SsoError) {
      loginError.searchParams.set("sso", err.reason);
      const res = NextResponse.redirect(loginError);
      clearOidcCookie(res);
      return res;
    }
    if (err instanceof SetupRequiredError || (err instanceof Error && err.message === "SETUP_REQUIRED")) {
      loginError.searchParams.set("sso", "setup");
      const res = NextResponse.redirect(loginError);
      clearOidcCookie(res);
      return res;
    }
    logger.error("sso.callback.failed", errorFields(err));
    return fail();
  }
}
