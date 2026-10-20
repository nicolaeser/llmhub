import type { OidcPreset, OidcProviderId } from "@/types/auth";

export const OIDC_PROVIDER_IDS = [
  "entra",
  "google",
  "okta",
  "keycloak",
  "authentik",
  "auth0",
  "generic",
] as const satisfies readonly OidcProviderId[];

export const DEFAULT_OIDC_SCOPES = "openid email profile";

export const MAX_ROLE_MAPPINGS = 50;

export const MAX_ALLOWED_DOMAINS = 50;

export const ENTRA_TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DISCOVERY_SUFFIX = /\/\.well-known\/openid-configuration$/i;

const ISSUER_PLACEHOLDER = /[{}]/;

const ENTRA_V1_ISSUER = /^https:\/\/sts\.windows\.net\/([^/]+)\/?$/i;

export const OIDC_PRESETS: Record<OidcProviderId, OidcPreset> = {
  entra: {
    issuer: "https://login.microsoftonline.com/{tenant-id}/v2.0",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "groups",
    docs: "https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc",
  },
  google: {
    issuer: "https://accounts.google.com",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "",
    docs: "https://developers.google.com/identity/openid-connect/openid-connect",
  },
  okta: {
    issuer: "https://{your-org}.okta.com",
    scopes: `${DEFAULT_OIDC_SCOPES} groups`,
    groupsClaim: "groups",
    docs: "https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/",
  },
  keycloak: {
    issuer: "https://{host}/realms/{realm}",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "groups",
    docs: "https://www.keycloak.org/docs/latest/server_admin/#_oidc_clients",
  },
  authentik: {
    issuer: "https://{host}/application/o/{slug}/",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "groups",
    docs: "https://docs.goauthentik.io/add-secure-apps/providers/oauth2/",
  },
  auth0: {
    issuer: "https://{tenant}.auth0.com/",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "https://llmhub/roles",
    docs: "https://auth0.com/docs/secure/tokens/json-web-tokens/create-custom-claims",
  },
  generic: {
    issuer: "",
    scopes: DEFAULT_OIDC_SCOPES,
    groupsClaim: "groups",
    docs: "",
  },
};

export function oidcScopes(raw: string): string {
  const scopes = raw.split(/\s+/).filter(Boolean);
  return [...new Set(["openid", ...scopes])].join(" ");
}

export function mappedRoleId(mappings: readonly { group: string; role_id: string }[], values: readonly string[]) {
  const wanted = new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return mappings.find((mapping) => wanted.has(mapping.group.trim().toLowerCase()))?.role_id ?? null;
}

export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
  if (!domains.length) return true;
  const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
  return domains.some((allowed) => allowed.trim().toLowerCase() === domain);
}

export function trimIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "").replace(DISCOVERY_SUFFIX, "").replace(/\/+$/, "");
}

export function issuerHasPlaceholder(issuer: string): boolean {
  return ISSUER_PLACEHOLDER.test(issuer);
}

export function entraV2Issuer(issuer: string): string | null {
  const tenant = ENTRA_V1_ISSUER.exec(issuer.trim())?.[1] ?? "";
  return ENTRA_TENANT_ID.test(tenant) ? `https://login.microsoftonline.com/${tenant.toLowerCase()}/v2.0` : null;
}

export function suggestedIssuer(discovered: string): string | null {
  if (!discovered.trim() || issuerHasPlaceholder(discovered)) return null;
  return entraV2Issuer(discovered) ?? trimIssuer(discovered);
}
