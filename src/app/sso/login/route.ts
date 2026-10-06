import { NextRequest, NextResponse } from "next/server";
import { getEnterprise } from "@/lib/gateway/settings";
import {
  buildAuthorizationUrl,
  fetchOidcDiscovery,
  oidcIsReady,
  oidcStateCookieOptions,
  resolveOidc,
  signOidcState,
} from "@/lib/auth/oidc";
import { sanitizeReturnPath } from "@/lib/auth/return-path";
import { logger } from "@/lib/logging/logger";
import { operatorCount } from "@/lib/bootstrap/operators";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const loginError = new URL("/account/login", req.url);
  try {
    if ((await operatorCount()) === 0) {
      loginError.searchParams.set("sso", "setup");
      return NextResponse.redirect(loginError);
    }
    const enterprise = await getEnterprise();
    const resolved = resolveOidc(enterprise.oidc);
    if (!oidcIsReady(enterprise.oidc)) {
      loginError.searchParams.set("sso", "disabled");
      return NextResponse.redirect(loginError);
    }
    const disc = await fetchOidcDiscovery(resolved.issuer);
    const returnPath = sanitizeReturnPath(req.nextUrl.searchParams.get("return")) ?? "";
    const state = signOidcState({ returnPath });
    const location = buildAuthorizationUrl(disc, resolved, state);
    const res = NextResponse.redirect(location);
    const opts = oidcStateCookieOptions();
    res.cookies.set(opts.name, state.cookie, opts);
    return res;
  } catch (err) {
    logger.error("sso.login.failed", { err: String(err) });
    loginError.searchParams.set("sso", "error");
    return NextResponse.redirect(loginError);
  }
}
