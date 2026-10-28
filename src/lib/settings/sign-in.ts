import "server-only";

import prisma from "@/lib/db/prisma";
import { parseAuthInput } from "@/lib/auth/errors";
import { assertCanGrant, canGrant, grantActor } from "@/lib/auth/grants";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { readAppRolesCheck } from "@/lib/auth/app-roles-check";
import { JWT_ALGORITHMS } from "@/lib/auth/jwks";
import {
  appRolesOffered,
  fetchOidcDiscovery,
  oidcCallbackUrl,
  OidcDiscoveryError,
  oidcFailureFields,
  oidcIsReady,
  resetOidcCache,
  tokenAuthMethod,
} from "@/lib/auth/oidc";
import { trimIssuer } from "@/lib/auth/oidc-presets";
import { hasPerm, permissionList, permissions, PERMISSIONS } from "@/lib/auth/permissions";
import { roleOptions } from "@/lib/auth/roles";
import {
  issueScimToken as mintScimToken,
  revokeScimToken as clearScimToken,
  scimTokenSet,
} from "@/lib/auth/scim";
import { requireStepUp } from "@/lib/auth/second-factor";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { getEnterprise, normalizeOidc, patchEnterprise } from "@/lib/settings/enterprise";
import { stepUpSchema } from "@/schemas/auth";
import { appRolesModeSchema, issuerCheckSchema, signInSaveSchema } from "@/schemas/settings";
import type { AuthenticatedSession, OidcSettings } from "@/types/auth";
import type { IssuerCheck, SignInSettingsView } from "@/types/settings";

async function view(oidc: OidcSettings, session: AuthenticatedSession): Promise<SignInSettingsView> {
  const actor = grantActor(session);
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  const [roles, orgs, scimToken, scimGroups, appRolesCheck] = await Promise.all([
    roleOptions(actor),
    prisma.organization.findMany({ orderBy: { alias: "asc" }, select: { id: true, alias: true } }),
    scimTokenSet(),
    prisma.scimGroup.count(),
    oidc.issuer ? readAppRolesCheck(session.user.id, oidc.issuer) : null,
  ]);
  return {
    oidc,
    firstSetup: !oidc.issuer,
    appRolesCheck,
    callbackUrl: oidcCallbackUrl(),
    scimUrl: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/scim/v2`,
    secretSet: Boolean(env.OIDC_CLIENT_SECRET),
    roles,
    orgs,
    scimTokenSet: scimToken,
    scimGroups,
    canManage,
    canManageScim: canManage && canGrant(actor, permissions),
  };
}

async function assertDirectoryTargets(oidc: OidcSettings, session: AuthenticatedSession) {
  const roleIds = [...new Set([...oidc.role_mappings.map((mapping) => mapping.role_id), oidc.default_role_id])].filter(
    Boolean,
  );
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { permissions: true } });
  if (roles.length !== roleIds.length) throw new Error("ROLE_NOT_FOUND");
  const actor = grantActor(session);
  for (const role of roles) assertCanGrant(actor, permissionList(role.permissions));
  if (oidc.default_org_id) {
    const org = await prisma.organization.findUnique({ where: { id: oidc.default_org_id }, select: { id: true } });
    if (!org) throw new Error("ORG_NOT_FOUND");
  }
}

export async function loadSignInSettings() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(normalizeOidc((await getEnterprise()).oidc), session);
}

async function offersAppRoles(issuer: string): Promise<boolean> {
  try {
    return appRolesOffered(await fetchOidcDiscovery(issuer));
  } catch (err) {
    logger.warn("settings.oidc_check_failed", { ...errorFields(err), ...oidcFailureFields(err) });
    return false;
  }
}

async function savedAppRolesMode(
  previous: OidcSettings,
  input: { issuer: string; role_fields_touched: boolean },
): Promise<boolean> {
  if (previous.app_roles) return true;
  if (previous.issuer || !input.issuer || input.role_fields_touched) return false;
  if (await prisma.userIdentity.count({ where: { issuer: { in: [input.issuer, `${input.issuer}/`] } } })) return false;
  return offersAppRoles(input.issuer);
}

export async function saveSignInSettings(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = signInSaveSchema.safeParse(raw);
  if (!parsed.success) {
    const badUrl = parsed.error.issues.some((issue) => issue.path[0] === "issuer");
    throw new Error(badUrl ? "INVALID_URL" : "VALIDATION");
  }
  const previous = normalizeOidc((await getEnterprise()).oidc);
  const oidc = normalizeOidc({ ...parsed.data, app_roles: await savedAppRolesMode(previous, parsed.data) });
  await assertDirectoryTargets(oidc, session);
  const enterprise = await patchEnterprise({ oidc });
  resetOidcCache();
  await writeAudit({
    actor: session.user.id,
    action: "settings.sign_in",
    objectType: "enterprise",
    objectId: "enterprise",
    after: oidc,
  });
  return view(normalizeOidc(enterprise.oidc), session);
}

export async function setAppRolesMode(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = appRolesModeSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const previous = normalizeOidc((await getEnterprise()).oidc);
  const on = parsed.data.on;
  if (on && !previous.app_roles) {
    if (!oidcIsReady(previous)) throw new Error("SSO_NOT_READY");
    resetOidcCache();
    if (!(await offersAppRoles(previous.issuer))) throw new Error("APP_ROLES_UNAVAILABLE");
    const check = await readAppRolesCheck(session.user.id, previous.issuer);
    if (check?.result !== "admin") throw new Error("APP_ROLES_CHECK_REQUIRED");
  }
  const enterprise = await patchEnterprise({ oidc: { ...previous, app_roles: on } });
  await writeAudit({
    actor: session.user.id,
    action: "settings.app_roles_mode",
    objectType: "enterprise",
    objectId: "enterprise",
    before: { app_roles: previous.app_roles },
    after: { app_roles: on },
  });
  return view(normalizeOidc(enterprise.oidc), session);
}

export async function checkOidcIssuer(raw: unknown): Promise<IssuerCheck> {
  await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = issuerCheckSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_URL");
  resetOidcCache();
  try {
    const disc = await fetchOidcDiscovery(parsed.data.issuer);
    const algorithms = disc.id_token_signing_alg_values_supported;
    return {
      ok: true,
      issuer: disc.issuer,
      usesTenantId: trimIssuer(disc.issuer) !== parsed.data.issuer,
      tokenAuth: tokenAuthMethod(disc.token_endpoint_auth_methods_supported),
      algorithms,
      supported: !algorithms.length || algorithms.some((alg) => JWT_ALGORITHMS.includes(alg)),
      appRoles: appRolesOffered(disc),
    };
  } catch (err) {
    logger.warn("settings.oidc_check_failed", { ...errorFields(err), ...oidcFailureFields(err) });
    return issuerFailure(err);
  }
}

function issuerFailure(err: unknown): IssuerCheck {
  if (!(err instanceof OidcDiscoveryError)) return { ok: false, reason: "unreachable" };
  return {
    ok: false,
    reason: err.reason,
    ...(err.status ? { status: err.status } : {}),
    ...(err.issuer ? { issuer: err.issuer } : {}),
  };
}

async function requireScimManager(input: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  assertCanGrant(grantActor(session), permissions);
  await requireStepUp(session.user.id, parseAuthInput(stepUpSchema, input).code);
  return session;
}

export async function issueScimToken(input: unknown) {
  const session = await requireScimManager(input);
  const scimToken = await mintScimToken();
  await writeAudit({
    actor: session.user.id,
    action: "settings.scim_token_issued",
    objectType: "scim",
    objectId: "scim",
  });
  return { scimToken };
}

export async function revokeScimToken(input: unknown) {
  const session = await requireScimManager(input);
  await clearScimToken();
  await writeAudit({
    actor: session.user.id,
    action: "settings.scim_token_revoked",
    objectType: "scim",
    objectId: "scim",
  });
  return { revoked: true as const };
}
