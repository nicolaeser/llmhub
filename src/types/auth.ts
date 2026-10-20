import type { Role, User } from "@/generated/prisma/client";
import type { SessionFactor } from "@/types/security";
import type { KeyObject } from "node:crypto";
import type { z } from "zod";
import type { oidcSettingsSchema } from "@/schemas/settings";

export type PermissionDomain =
  | "keys"
  | "providers"
  | "models"
  | "tenancy"
  | "spend"
  | "access"
  | "settings"
  | "tools"
  | "integrations"
  | "mcp";

export type PermissionLevel = "view" | "work" | "sensitive";

export type Permission =
  | "keys:read"
  | "keys:read-all"
  | "keys:manage"
  | "providers:read"
  | "providers:manage"
  | "models:read"
  | "models:manage"
  | "tenancy:read"
  | "tenancy:manage"
  | "spend:read"
  | "spend:read-all"
  | "logs:content"
  | "budgets:manage"
  | "pricing:read"
  | "pricing:manage"
  | "users:read"
  | "users:manage"
  | "users:security"
  | "roles:manage"
  | "settings:read"
  | "settings:manage"
  | "playground:use"
  | "integrations:read"
  | "integrations:manage"
  | "integrations:publish"
  | "integrations:credentials"
  | "mcp:read"
  | "mcp:install"
  | "mcp:manage";

export type PermissionMeta = {
  domain: PermissionDomain;
  level: PermissionLevel;
};

export type RoleTemplateKey = "admin" | "operator" | "finance" | "viewer";

export type AuthErrorCode =
  | "VALIDATION"
  | "INVALID_CREDENTIALS"
  | "RATE_LIMITED"
  | "LOGIN_CHALLENGE_EXPIRED"
  | "INVALID_SECOND_FACTOR"
  | "SECOND_FACTOR_LOCKED"
  | "TWO_FACTOR_ENROLLMENT_REQUIRED"
  | "TWO_FACTOR_ALREADY_ENABLED"
  | "TWO_FACTOR_CHANGED"
  | "PASSKEY_VERIFICATION_FAILED"
  | "PASSKEY_CHALLENGE_EXPIRED"
  | "PASSKEY_LIMIT"
  | "PASSKEY_EXISTS"
  | "PASSKEY_NOT_FOUND"
  | "PASSKEYS_UNAVAILABLE"
  | "PASSWORD_INCORRECT"
  | "PASSWORD_REUSED"
  | "PASSWORD_CHANGED"
  | "WEAK_PASSWORD"
  | "PASSWORD_GUESSABLE"
  | "CURRENT_SESSION"
  | "FORBIDDEN"
  | "INVALID_SCOPE"
  | "ROLE_PROTECTED"
  | "ROLE_EXISTS"
  | "ROLE_IN_USE"
  | "ROLE_CHANGED"
  | "ROLE_NOT_FOUND"
  | "ROLE_NOT_TEMPLATE"
  | "NAME_REQUIRED"
  | "USER_PROTECTED"
  | "OWNER_PROTECTED"
  | "CANNOT_SELF"
  | "USER_EXISTS"
  | "USER_NOT_FOUND"
  | "USER_CHANGED"
  | "KEY_LIMIT"
  | "SSO_REQUIRED"
  | "NOT_FOUND";

type SessionRole = Pick<Role, "id" | "templateKey" | "name">;

export type AuthenticatedSession = {
  error: false;
  sessionId: string;
  user: User;
  isOwner: boolean;
  role: SessionRole | null;
  permissions: Permission[];
  secondFactor: SessionFactor | "MANAGEMENT_KEY";
  ipAddress: string | null;
  userAgent: string | null;
  workspaceOrgId?: string | null;
};

export type SessionResult =
  | AuthenticatedSession
  | { error: true; message: string };

export type RequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

export type GrantActor = {
  isOwner: boolean;
  permissions: readonly Permission[];
};

export type RoleSummary = {
  id: string;
  templateKey: RoleTemplateKey | null;
  name: string | null;
  description: string | null;
  permissions: Permission[];
  memberCount: number;
  revision: number;
  editable: boolean;
};

export type RoleOption = {
  id: string;
  templateKey: RoleTemplateKey | null;
  name: string | null;
  assignable: boolean;
};

export type RolesConsolePayload = {
  roles: RoleSummary[];
  grantable: Permission[];
  missingTemplates: RoleTemplateKey[];
};

export type DigestPurpose = "recovery-code";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  token_endpoint_auth_methods_supported: string[];
  id_token_signing_alg_values_supported: string[];
};

export type OidcTokenAuth = "client_secret_basic" | "client_secret_post";

export type ResolvedOidc = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
  groupsClaim: string;
};

export type OidcEnv = {
  clientSecret?: string;
  appUrl?: string;
};

export type OidcDiscoveryCache = { issuer: string; disc: OidcDiscovery; fetched: number };

export type OidcDiscoveryFailure =
  | "unreachable"
  | "http"
  | "not_json"
  | "issuer_mismatch"
  | "multi_tenant"
  | "incomplete";

export type OidcDiscoveryFailureDetail = { status?: number; issuer?: string };

export type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  codeChallenge: string;
  returnPath: string;
  cookie: string;
};

export type VerifiedOidcState = {
  nonce: string;
  verifier: string;
  returnPath: string;
};

export type TargetRow = {
  id: string;
  isOwner: boolean;
  orgId: string | null;
  role: { permissions: string[] } | null;
};

export type OidcSettings = z.infer<typeof oidcSettingsSchema>;

export type OidcProviderId = "entra" | "google" | "okta" | "keycloak" | "authentik" | "auth0" | "generic";

export type OidcPreset = {
  issuer: string;
  scopes: string;
  groupsClaim: string;
  docs: string;
};

export type RoleMapping = OidcSettings["role_mappings"][number];

export type OidcIdentity = {
  issuer: string;
  subject: string;
  email: string;
  groups: string[];
  externalIds: string[];
};

export type SsoFailure = "owner" | "domain" | "conflict" | "email";

export type Jwk = {
  kty?: string;
  kid?: string;
  crv?: string;
  alg?: string;
  use?: string;
};

export type JwtAlgorithm = {
  kty: "RSA" | "EC" | "OKP";
  hash: string | null;
  curves?: readonly string[];
  saltLength?: number;
};

export type VerificationKey = {
  kid: string;
  kty: string;
  crv: string;
  alg: string;
  key: KeyObject;
};

export type JwksCache = { url: string; keys: VerificationKey[]; fetched: number };

export type JwtClaims = Record<string, unknown>;

export type JwtConfig = {
  issuer?: string;
  audience?: string;
  jwks_url?: string;
};
