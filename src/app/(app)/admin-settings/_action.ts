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
import {
  catalogRouting,
  DEFAULT_JEV_MODEL,
  getEnterprise,
  normalizeVectorDefaults,
  patchEnterprise,
} from "@/lib/gateway/settings";
import { assistantModelLocked } from "@/lib/assistant/parse";
import { checkForUpdate } from "@/lib/updates/update-check";
import { resolveS3Config } from "@/lib/s3/config";
import { env } from "@/lib/env";
import { stepUpSchema } from "@/schemas/auth";
import type { AuthenticatedSession } from "@/types/auth";
import { adminSettingsSchema } from "@/schemas/settings";
import type { AdminSettings } from "@/types/settings";
import type { Enterprise } from "@/types/gateway";
import type { VectorStoreDefaults } from "@/types/rag";

async function view(enterprise: Enterprise, session: AuthenticatedSession) {
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  const [aliases, scimToken, s3Ready] = await Promise.all([
    prisma.modelGroup.findMany({ where: { enabled: true }, select: { alias: true }, orderBy: { alias: "asc" } }),
    scimTokenSet(),
    resolveS3Config(),
  ]);
  return {
    settings: {
      registration_enabled: enterprise.registration_enabled === true,
      assistant_model: enterprise.assistant_model ?? "",
      assistant_model_locked: assistantModelLocked(enterprise),
      update_check: enterprise.update_check !== false,
      catalog_auto_routes: catalogRouting(enterprise).autoRoutes,
      catalog_min_confidence: catalogRouting(enterprise).minConfidence,
      catalog_jev: {
        enabled: enterprise.catalog_jev?.enabled === true,
        model: enterprise.catalog_jev?.model ?? DEFAULT_JEV_MODEL,
        api_key: "",
        clear_api_key: false,
      },
      vector_stores: normalizeVectorDefaults(enterprise.vector_stores),
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
    jevKeySet: Boolean(enterprise.catalog_jev?.api_key),
    updates: await checkForUpdate(enterprise.update_check !== false),
    scimTokenSet: scimToken,
    s3Ready: Boolean(s3Ready),
    oidcEnv: Boolean(env.OIDC_CLIENT_SECRET),
    smtpEnv: Boolean(env.SMTP_URL),
    appUrl: env.NEXT_PUBLIC_APP_URL,
  };
}

async function assertNewAliases(next: VectorStoreDefaults, previous: VectorStoreDefaults) {
  const known = new Set([previous.embedding_model, previous.ocr_model, previous.rerank_model]);
  const wanted = [...new Set([next.embedding_model, next.ocr_model, next.rerank_model])].filter(
    (alias) => alias && !known.has(alias),
  );
  if (!wanted.length) return;
  const found = await prisma.modelGroup.count({ where: { alias: { in: wanted } } });
  if (found !== wanted.length) throw new Error("UNKNOWN_MODEL");
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
    const { catalog_jev: jevInput, ...rest } = parsed.data;
    const current = await getEnterprise();
    const apiKey = jevInput.clear_api_key ? "" : jevInput.api_key || current.catalog_jev?.api_key || "";
    if (jevInput.enabled && !apiKey) return actionFail("JEV_KEY_REQUIRED");
    await assertNewAliases(rest.vector_stores, normalizeVectorDefaults(current.vector_stores));
    const jev = { enabled: jevInput.enabled, model: jevInput.model || DEFAULT_JEV_MODEL };
    const settings = { ...rest, assistant_model_locked: assistantModelLocked(rest) };
    const enterprise = await patchEnterprise({ ...settings, catalog_jev: { ...jev, api_key: apiKey } });
    await writeAudit({
      actor: session.user.id,
      action: "settings.admin",
      objectType: "enterprise",
      objectId: "enterprise",
      after: {
        ...settings,
        catalog_jev: { ...jev, api_key_changed: Boolean(jevInput.api_key) || jevInput.clear_api_key },
      },
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
