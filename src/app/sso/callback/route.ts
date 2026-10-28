import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";
import { createSession, revokeSessionCookie } from "@/lib/auth/session";
import { completeAppRolesCheck } from "@/lib/auth/app-roles-check";
import {
  OIDC_ROLE_CHECK_COOKIE,
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
import { env } from "@/lib/env";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import { clientIp } from "@/lib/http/client-ip";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";

const IDP_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function idpErrorCode(value: string): string {
  return IDP_ERROR_CODE.test(value) ? value : "other";
}

function clearOidcCookie(res: NextResponse, name = OIDC_STATE_COOKIE) {
  const opts = oidcStateCookieOptions(0, name);
  res.cookies.set(opts.name, "", opts);
}

async function finishRoleCheck(input: { code: string; nonce: string; verifier: string; idpError: string }) {
  const result = await completeAppRolesCheck(input);
  const target = result ? "/settings?tab=sign-in" : "/account/login";
  const res = NextResponse.redirect(new URL(target, env.NEXT_PUBLIC_APP_URL));
  clearOidcCookie(res, OIDC_ROLE_CHECK_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const loginError = new URL("/account/login", env.NEXT_PUBLIC_APP_URL);
  loginError.searchParams.set("sso", "error");
  const fail = () => {
    const res = NextResponse.redirect(loginError);
    clearOidcCookie(res);
    return res;
  };
  const reject = (reason: string, meta: Record<string, string> = {}) => {
    logger.warn("sso.callback.rejected", { reason, ...meta });
    return fail();
  };

  try {
    const idpError = req.nextUrl.searchParams.get("error");
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const checkCookie = req.cookies.get(OIDC_ROLE_CHECK_COOKIE)?.value ?? "";
    const roleCheck = state && checkCookie ? verifyOidcState({ cookie: checkCookie, state, purpose: "role_check" }) : null;
    if (roleCheck) {
      return finishRoleCheck({ code, ...roleCheck, idpError: idpError ? idpErrorCode(idpError) : "" });
    }
    if (idpError) return reject("idp_error", { idpError: idpErrorCode(idpError) });
    const cookie = req.cookies.get(OIDC_STATE_COOKIE)?.value ?? "";
    if (!code) return reject("missing_code");
    if (!state) return reject("missing_state");
    if (!cookie) return reject("missing_state_cookie");

    const verified = verifyOidcState({ cookie, state });
    if (!verified) return reject("state_mismatch");

    const enterprise = await getEnterprise();
    if (!oidcIsReady(enterprise.oidc)) return reject("not_configured");
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
    const res = NextResponse.redirect(new URL(dest, env.NEXT_PUBLIC_APP_URL));
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
      return reject("setup_required");
    }
    logger.error("sso.callback.failed", errorFields(err));
    return fail();
  }
}
