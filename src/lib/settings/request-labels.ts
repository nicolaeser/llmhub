import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import { cleanLabelKeys } from "@/lib/usage/labels";

export async function savePlatformLabelKeys(input: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const label_keys = cleanLabelKeys(input);
  const before = (await getEnterprise()).label_keys ?? [];
  await patchEnterprise({ label_keys });
  await writeAudit({
    actor: session.user.id,
    action: "settings.request_labels",
    objectType: "enterprise",
    objectId: "enterprise",
    before: { label_keys: before },
    after: { label_keys },
  });
  return { keys: label_keys };
}
