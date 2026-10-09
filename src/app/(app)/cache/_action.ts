"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import { cacheBackend } from "@/lib/gateway/cache";
import { CACHE_STATS_DEFAULT_DAYS } from "@/lib/gateway/cache-settings";
import { getEnterprise, normalizeSemanticCache, patchEnterprise } from "@/lib/gateway/settings";
import { cacheTotals } from "@/lib/gateway/usage-totals";
import { cacheSettingsSchema, cacheStatsSchema } from "@/schemas/settings";
import type { Permission } from "@/types/auth";
import type { CacheSettingsInput, CacheView } from "@/types/cache";

async function view(permissions: readonly Permission[]): Promise<CacheView> {
  const [enterprise, backend, aliases] = await Promise.all([
    getEnterprise(),
    cacheBackend(),
    prisma.modelGroup.findMany({ where: { enabled: true }, select: { alias: true }, orderBy: { alias: "asc" } }),
  ]);
  return {
    cacheTtlSeconds: enterprise.cache_ttl_seconds ?? 0,
    semantic: normalizeSemanticCache(enterprise.cache_semantic),
    backend,
    aliases: aliases.map((row) => row.alias),
    stats: hasPerm(permissions, PERMISSIONS.SPEND_READ_ALL) ? await cacheTotals(CACHE_STATS_DEFAULT_DAYS) : null,
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

export async function loadCacheAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return view(session.permissions);
  });
}

export async function loadCacheStatsAction(input: { days: number }) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL)) return actionFail("FORBIDDEN");
    const parsed = cacheStatsSchema.safeParse(input);
    if (!parsed.success) return actionFail("VALIDATION");
    return cacheTotals(parsed.data.days);
  });
}

export async function saveCacheAction(input: CacheSettingsInput) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = cacheSettingsSchema.safeParse(input);
    if (!parsed.success) return actionFail("VALIDATION");
    const after = {
      ...(parsed.data.cacheTtlSeconds === undefined ? {} : { cache_ttl_seconds: parsed.data.cacheTtlSeconds }),
      ...(parsed.data.semantic ? { cache_semantic: normalizeSemanticCache(parsed.data.semantic) } : {}),
    };
    await patchEnterprise(after);
    await writeAudit({
      actor: session.user.id,
      action: "settings.cache",
      objectType: "enterprise",
      objectId: "enterprise",
      after,
    });
    return view(session.permissions);
  });
}
