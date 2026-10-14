import "server-only";

import { assertModelRoles, enabledModelChoices } from "@/lib/models/aliases";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { cacheBackend } from "@/lib/gateway/cache/response-cache";
import { CACHE_STATS_DEFAULT_DAYS } from "@/lib/gateway/cache/cache-settings";
import { getEnterprise, normalizeSemanticCache, patchEnterprise } from "@/lib/settings/enterprise";
import { responseCacheTotals } from "@/lib/usage/usage-totals";
import { cacheSettingsSchema, cacheStatsSchema } from "@/schemas/settings";
import type { Permission } from "@/types/auth";
import type { CacheSettingsInput, CacheView } from "@/types/cache";

async function view(permissions: readonly Permission[]): Promise<CacheView> {
  const [enterprise, backend, models] = await Promise.all([
    getEnterprise(),
    cacheBackend(),
    enabledModelChoices(),
  ]);
  return {
    cacheTtlSeconds: enterprise.cache_ttl_seconds ?? 0,
    semantic: normalizeSemanticCache(enterprise.cache_semantic),
    backend,
    models,
    stats: hasPerm(permissions, PERMISSIONS.SPEND_READ_ALL) ? await responseCacheTotals(CACHE_STATS_DEFAULT_DAYS) : null,
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

export async function loadCache() {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  return view(session.permissions);
}

export async function loadCacheStats(input: { days: number }) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL)) throw new Error("FORBIDDEN");
  const parsed = cacheStatsSchema.safeParse(input);
  if (!parsed.success) throw new Error("VALIDATION");
  return responseCacheTotals(parsed.data.days);
}

export async function saveCache(input: CacheSettingsInput) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = cacheSettingsSchema.safeParse(input);
  if (!parsed.success) throw new Error("VALIDATION");
  const previous = normalizeSemanticCache((await getEnterprise()).cache_semantic).model;
  const nextModel = parsed.data.semantic?.model ?? "";
  if (nextModel && nextModel !== previous) await assertModelRoles([{ alias: nextModel, role: "embedding" }]);
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
}
