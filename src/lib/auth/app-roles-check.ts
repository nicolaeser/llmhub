import "server-only";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { requirePlatformPermission } from "@/lib/auth/guards";
import {
  appRolesOffered,
  buildAuthorizationUrl,
  exchangeOidcCode,
  fetchOidcDiscovery,
  OIDC_ROLE_CHECK_COOKIE,
  oidcIsReady,
  oidcStateCookieOptions,
  resolveOidc,
  signOidcState,
} from "@/lib/auth/oidc";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { asRecord, asString } from "@/lib/gateway/core";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { AppRolesCheck, AppRolesCheckResult, OidcSettings } from "@/types/auth";

const CHECK_KEY = "app_roles_check";
export const APP_ROLES_CHECK_TTL_MS = 15 * 60_000;
const RESULTS: readonly AppRolesCheckResult[] = ["admin", "no_admin", "other_account", "unavailable", "failed"];

export async function startAppRolesCheck(): Promise<{ url: string }> {
  await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  if (!oidcIsReady(oidc)) throw new Error("SSO_NOT_READY");
  const resolved = resolveOidc(oidc);
  const disc = await fetchOidcDiscovery(resolved.issuer);
  if (!appRolesOffered(disc)) throw new Error("APP_ROLES_UNAVAILABLE");
  const state = signOidcState({ purpose: "role_check" });
  const opts = oidcStateCookieOptions(undefined, OIDC_ROLE_CHECK_COOKIE);
  (await cookies()).set(opts.name, state.cookie, opts);
  return { url: buildAuthorizationUrl(disc, resolved, state) };
}

async function checkIdentity(
  oidc: OidcSettings,
  userId: string,
  input: { code: string; nonce: string; verifier: string },
): Promise<Omit<AppRolesCheck, "at">> {
  const identity = await exchangeOidcCode({ resolved: resolveOidc(oidc), ...input });
  if (identity.appRoles === null) return { result: "unavailable", email: identity.email };
  const linked = await prisma.userIdentity.findUnique({
    where: { userId_issuer: { userId, issuer: identity.issuer } },
    select: { subject: true },
  });
  if (linked && linked.subject !== identity.subject) return { result: "other_account", email: identity.email };
  return { result: identity.appRoles.includes("admin") ? "admin" : "no_admin", email: identity.email };
}

type CheckInput = { code: string; nonce: string; verifier: string; idpError: string };

async function checkOutcome(oidc: OidcSettings, userId: string, input: CheckInput): Promise<Omit<AppRolesCheck, "at">> {
  if (input.idpError) return { result: input.idpError === "access_denied" ? "no_admin" : "failed", email: "" };
  if (!input.code || !oidcIsReady(oidc)) return { result: "failed", email: "" };
  try {
    return await checkIdentity(oidc, userId, input);
  } catch (err) {
    logger.warn("settings.app_roles_check_failed", errorFields(err));
    return { result: "failed", email: "" };
  }
}

export async function completeAppRolesCheck(input: CheckInput): Promise<AppRolesCheckResult | null> {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE).catch(() => null);
  if (!session) return null;
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  const outcome = await checkOutcome(oidc, session.user.id, input);
  const check = { userId: session.user.id, issuer: oidc.issuer, ...outcome, at: Date.now() };
  await prisma.setting.upsert({
    where: { key: CHECK_KEY },
    update: { value: JSON.stringify(check) },
    create: { key: CHECK_KEY, value: JSON.stringify(check) },
  });
  await writeAudit({
    actor: session.user.id,
    action: "settings.app_roles_check",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { result: check.result },
  });
  return check.result;
}

export async function readAppRolesCheck(userId: string, issuer: string, now = Date.now()): Promise<AppRolesCheck | null> {
  const row = await prisma.setting.findUnique({ where: { key: CHECK_KEY } });
  const rec = asRecord(parseJsonOrNull(row?.value ?? ""));
  if (!rec || rec.userId !== userId || rec.issuer !== issuer) return null;
  const at = typeof rec.at === "number" ? rec.at : 0;
  const result = RESULTS.find((value) => value === rec.result);
  if (!result || now - at > APP_ROLES_CHECK_TTL_MS) return null;
  return { result, email: asString(rec.email), at };
}
