"use server";

import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { getEnterprise, patchEnterprise } from "@/lib/gateway/settings";

async function view(canManage: boolean) {
  const enterprise = await getEnterprise();
  return {
    cacheTtlSeconds: enterprise.cache_ttl_seconds ?? 0,
    canManage,
  };
}

export async function loadCacheAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return view(hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE));
  });
}

export async function saveCacheAction(input: { cacheTtlSeconds: number }) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const after = {
      cache_ttl_seconds: Math.max(0, Math.trunc(input.cacheTtlSeconds) || 0),
    };
    await patchEnterprise(after);
    await writeAudit({
      actor: session.user.id,
      action: "settings.cache",
      objectType: "enterprise",
      objectId: "enterprise",
      after,
    });
    return view(true);
  });
}
