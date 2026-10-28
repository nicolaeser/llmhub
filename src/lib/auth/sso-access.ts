import "server-only";
import { fetchOidcDiscovery, oidcIsReady, requestAccessUrl, resolveOidc } from "@/lib/auth/oidc";
import { providerName } from "@/lib/auth/oidc-presets";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import type { SsoAccessHelp } from "@/types/auth";

export async function ssoAccessHelp(): Promise<SsoAccessHelp> {
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  if (!oidcIsReady(oidc)) return { provider: "", requestAccessUrl: "" };
  const resolved = resolveOidc(oidc);
  try {
    return { provider: providerName(oidc), requestAccessUrl: requestAccessUrl(await fetchOidcDiscovery(resolved.issuer), resolved) };
  } catch (err) {
    logger.warn("sso.access_help_failed", errorFields(err));
    return { provider: providerName(oidc), requestAccessUrl: "" };
  }
}
