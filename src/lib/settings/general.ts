import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { s3KeysPresent } from "@/lib/s3/config";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import { checkForUpdate } from "@/lib/updates/update-check";
import { readUpdaterRows } from "@/lib/updates/updater-store";
import { updaterView } from "@/lib/updates/updater-view";
import { generalSettingsSchema } from "@/schemas/settings";
import type { Permission } from "@/types/auth";
import type { Enterprise, GeneralSettingsView } from "@/types/settings";

async function view(enterprise: Enterprise, permissions: readonly Permission[]): Promise<GeneralSettingsView> {
  const keys = s3KeysPresent();
  const updater = await readUpdaterRows();
  return {
    settings: {
      registration_enabled: enterprise.registration_enabled === true,
      update_check: enterprise.update_check !== false,
    },
    updates: await checkForUpdate(enterprise.update_check !== false),
    updater: updaterView(updater.status, updater.command, updater.auto, Date.now()),
    env: {
      appUrl: env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, ""),
      s3Keys: keys.accessKeyId && keys.secretAccessKey,
      oidcSecret: Boolean(env.OIDC_CLIENT_SECRET),
      smtp: Boolean(env.SMTP_URL),
      redis: Boolean(env.REDIS_URL),
    },
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

export async function loadGeneralSettings() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(await getEnterprise(), session.permissions);
}

export async function saveGeneralSettings(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = generalSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const enterprise = await patchEnterprise(parsed.data);
  await writeAudit({
    actor: session.user.id,
    action: "settings.general",
    objectType: "enterprise",
    objectId: "enterprise",
    after: parsed.data,
  });
  return view(enterprise, session.permissions);
}
