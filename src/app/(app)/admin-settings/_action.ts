"use server";

import prisma from "@/lib/db/prisma";
import { parseAuthInput } from "@/lib/auth/errors";
import { assertCanGrant, canGrant, grantActor } from "@/lib/auth/grants";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, permissions, PERMISSIONS } from "@/lib/auth/permissions";
import { requireStepUp } from "@/lib/auth/second-factor";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { issueScimToken, revokeScimToken, scimTokenSet } from "@/lib/gateway/scim";
import { getEnterprise, patchEnterprise } from "@/lib/gateway/settings";
import { resolveS3Config } from "@/lib/s3/config";
import { env } from "@/lib/env";
import { stepUpSchema } from "@/schemas/auth";
import type { AuthenticatedSession } from "@/types/auth";
import { adminSettingsSchema } from "@/schemas/settings";
import type { AdminSettings } from "@/types/settings";
import type { Enterprise } from "@/types/gateway";

async function view(enterprise: Enterprise, session: AuthenticatedSession) {
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  const [aliases, scimToken, s3Ready] = await Promise.all([
    prisma.modelGroup.findMany({ select: { alias: true }, orderBy: { alias: "asc" } }),
    scimTokenSet(),
    resolveS3Config(),
  ]);
  return {
    settings: {
      registration_enabled: enterprise.registration_enabled === true,
      assistant_model: enterprise.assistant_model ?? "",
      oidc: {
        enabled: enterprise.oidc?.enabled === true,
        issuer: enterprise.oidc?.issuer ?? "",
        client_id: enterprise.oidc?.client_id ?? "",
        redirect_url: enterprise.oidc?.redirect_url ?? "",
      },
      s3: {
        enabled: enterprise.s3?.enabled === true,
        bucket: enterprise.s3?.bucket ?? "",
        region: enterprise.s3?.region ?? "us-east-1",
        endpoint: enterprise.s3?.endpoint ?? "",
        prefix: enterprise.s3?.prefix ?? "",
        addressing: enterprise.s3?.addressing ?? "auto",
        public_base_url: enterprise.s3?.public_base_url ?? "",
        domain_bucket: enterprise.s3?.domain_bucket === true,
      },
    } satisfies AdminSettings,
    aliases: aliases.map((row) => row.alias),
    canManage,
    canManageScim: canManage && canGrant(grantActor(session), permissions),
    scimTokenSet: scimToken,
    s3Ready: Boolean(s3Ready),
    oidcEnv: Boolean(env.OIDC_CLIENT_SECRET),
    smtpEnv: Boolean(env.SMTP_URL),
    appUrl: env.NEXT_PUBLIC_APP_URL,
  };
}

export async function loadAdminSettingsAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return view(await getEnterprise(), session);
  });
}

export async function saveAdminSettingsAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = adminSettingsSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    const enterprise = await patchEnterprise(parsed.data);
    await writeAudit({
      actor: session.user.id,
      action: "settings.admin",
      objectType: "enterprise",
      objectId: "enterprise",
      after: parsed.data,
    });
    return view(enterprise, session);
  });
}

async function requireScimManager(input: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  assertCanGrant(grantActor(session), permissions);
  await requireStepUp(session.user.id, parseAuthInput(stepUpSchema, input).code);
  return session;
}

export async function issueScimTokenAction(input: unknown) {
  return runAction(async () => {
    const session = await requireScimManager(input);
    const scimToken = await issueScimToken();
    await writeAudit({
      actor: session.user.id,
      action: "settings.scim_token_issued",
      objectType: "scim",
      objectId: "scim",
    });
    return { scimToken };
  });
}

export async function revokeScimTokenAction(input: unknown) {
  return runAction(async () => {
    const session = await requireScimManager(input);
    await revokeScimToken();
    await writeAudit({
      actor: session.user.id,
      action: "settings.scim_token_revoked",
      objectType: "scim",
      objectId: "scim",
    });
    return { revoked: true as const };
  });
}
