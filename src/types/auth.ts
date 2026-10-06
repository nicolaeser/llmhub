import type { Role, User } from "@/generated/prisma/client";
import type { SessionFactor } from "@/types/security";

export type PermissionDomain =
  | "keys"
  | "providers"
  | "models"
  | "tenancy"
  | "spend"
  | "access"
  | "settings"
  | "tools";

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
  | "users:read"
  | "users:manage"
  | "users:security"
  | "roles:manage"
  | "settings:read"
  | "settings:manage"
  | "playground:use"
  | "assistant:use";

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
};

export type ResolvedOidc = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
};

export type OidcEnv = {
  clientSecret?: string;
  appUrl?: string;
};

export type DiscCache = { issuer: string; disc: OidcDiscovery; fetched: number };

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
  role: { permissions: string[] } | null;
};
