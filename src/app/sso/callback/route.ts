import { NextRequest, NextResponse } from "next/server";
import { clearedSessionCookieOptions, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";
import { createSession, revokeSessionCookie } from "@/lib/auth/session";
import { completeAppRolesCheck } from "@/lib/auth/app-roles-check";
import {
  OIDC_STATE_COOKIE,
  exchangeOidcGrant,
  oidcIsReady,
  oidcStateCookieOptions,
  resolveOidc,
  verifyOidcState,
} from "@/lib/auth/oidc";
import { sanitizeReturnPath, withReturnQuery } from "@/lib/auth/return-path";
import { recordSsoSession } from "@/lib/auth/sso-sessions";
import { sessionHeldBy, signInWithSso, SsoError } from "@/lib/auth/sso-user";
import { SetupRequiredError } from "@/lib/bootstrap/operators";
import { env } from "@/lib/env";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import { clientIp } from "@/lib/http/client-ip";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";

const IDP_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function idpErrorCode(value: string): string {
  if (!value) return "";
  return IDP_ERROR_CODE.test(value) ? value : "other";
}

function clearOidcCookie(res: NextResponse) {
  const opts = oidcStateCookieOptions(0);
  res.cookies.set(opts.name, "", opts);
}

async function finishRoleCheck(input: { code: string; nonce: string; verifier: string; idpError: string }) {
  const result = await completeAppRolesCheck(input);
  const target = result ? "/settings?tab=sign-in" : "/account/login";
  const res = NextResponse.redirect(new URL(target, env.NEXT_PUBLIC_APP_URL));
  clearOidcCookie(res);
  return res;
}

export async function GET(req: NextRequest) {
  const loginError = new URL("/account/login", env.NEXT_PUBLIC_APP_URL);
  loginError.searchParams.set("sso", "error");
  const browserSession = req.cookies.get(SESSION_COOKIE)?.value;
  let silentReturn: string | null = null;
  const leave = async (target: URL) => {
    const res = NextResponse.redirect(target);
    clearOidcCookie(res);
    if (silentReturn !== null) {
      await revokeSessionCookie(browserSession);
      res.cookies.set({ ...clearedSessionCookieOptions(), value: "" });
    }
    return res;
  };
  const fail = () => leave(loginError);
  const reject = (reason: string, meta: Record<string, string> = {}) => {
    if (silentReturn !== null) {
      logger.info("sso.silent.fallback", { reason, ...meta });
      return leave(new URL(withReturnQuery("/account/login", silentReturn), env.NEXT_PUBLIC_APP_URL));
    }
    logger.warn("sso.callback.rejected", { reason, ...meta });
    return fail();
  };

  try {
    const idpError = idpErrorCode(req.nextUrl.searchParams.get("error") ?? "");
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const cookie = req.cookies.get(OIDC_STATE_COOKIE)?.value ?? "";
    const refuse = (reason: string) => (idpError ? reject("idp_error", { idpError }) : reject(reason));
    if (!state) return refuse("missing_state");
    if (!cookie) return refuse("missing_state_cookie");

    const verified = verifyOidcState({ cookie, state });
    if (!verified) return refuse("state_mismatch");
    if (verified.purpose === "role_check") {
      return finishRoleCheck({ code, nonce: verified.nonce, verifier: verified.verifier, idpError });
    }
    if (verified.purpose === "silent") silentReturn = verified.returnPath;
    if (idpError) return reject("idp_error", { idpError });
    if (!code) return reject("missing_code");

    const enterprise = await getEnterprise();
    if (!oidcIsReady(enterprise.oidc)) return reject("not_configured");
    const resolved = resolveOidc(enterprise.oidc);
    const grant = await exchangeOidcGrant({
      resolved,
      code,
      nonce: verified.nonce,
      verifier: verified.verifier,
    });
    if (silentReturn !== null && !(await sessionHeldBy(browserSession, grant.identity))) return reject("other_account");
    const user = await signInWithSso(grant.identity, normalizeOidc(enterprise.oidc), clientIp(req.headers));
    if (user.blocked) {
      loginError.searchParams.set("sso", "blocked");
      return leave(loginError);
    }

    await revokeSessionCookie(browserSession);
    const session = await createSession(user.id, "SSO", {
      ipAddress: clientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    });
    await recordSsoSession(session.id, grant);
    const dest = sanitizeReturnPath(verified.returnPath) ?? "/";
    const res = NextResponse.redirect(new URL(dest, env.NEXT_PUBLIC_APP_URL));
    const opts = sessionCookieOptions(session.expiresAt);
    res.cookies.set(opts.name, session.cookie, opts);
    clearOidcCookie(res);
    return res;
  } catch (err) {
    if (err instanceof SsoError) {
      loginError.searchParams.set("sso", err.reason);
      return leave(loginError);
    }
    if (err instanceof SetupRequiredError || (err instanceof Error && err.message === "SETUP_REQUIRED")) {
      return reject("setup_required");
    }
    logger.error("sso.callback.failed", errorFields(err));
    return silentReturn === null ? fail() : reject("failed");
  }
}
