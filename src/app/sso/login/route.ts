import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getEnterprise } from "@/lib/settings/enterprise";
import {
  buildAuthorizationUrl,
  fetchOidcDiscovery,
  oidcFailureFields,
  oidcIsReady,
  oidcStateCookieOptions,
  resolveOidc,
  signOidcState,
} from "@/lib/auth/oidc";
import { sanitizeReturnPath } from "@/lib/auth/return-path";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const loginError = new URL("/account/login", env.NEXT_PUBLIC_APP_URL);
  try {
    const enterprise = await getEnterprise();
    const resolved = resolveOidc(enterprise.oidc);
    if (!oidcIsReady(enterprise.oidc)) {
      loginError.searchParams.set("sso", "disabled");
      return NextResponse.redirect(loginError);
    }
    const disc = await fetchOidcDiscovery(resolved.issuer);
    const returnPath = sanitizeReturnPath(req.nextUrl.searchParams.get("return")) ?? "";
    const silent = req.nextUrl.searchParams.get("prompt") === "none";
    const state = signOidcState({ returnPath, purpose: silent ? "silent" : "sign_in" });
    const location = buildAuthorizationUrl(disc, resolved, state, silent ? "none" : undefined);
    const res = NextResponse.redirect(location);
    const opts = oidcStateCookieOptions();
    res.cookies.set(opts.name, state.cookie, opts);
    return res;
  } catch (err) {
    logger.error("sso.login.failed", { ...errorFields(err), ...oidcFailureFields(err) });
    loginError.searchParams.set("sso", "error");
    return NextResponse.redirect(loginError);
  }
}
