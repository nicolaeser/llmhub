import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { assertModelRoles, enabledModelChoices } from "@/lib/models/aliases";
import {
  catalogRouting,
  DEFAULT_JEV_MODEL,
  getEnterprise,
  normalizeVectorDefaults,
  patchEnterprise,
} from "@/lib/settings/enterprise";
import { catalogSettingsSchema } from "@/schemas/settings";
import type { Permission } from "@/types/auth";
import type { CatalogSettingsView, Enterprise } from "@/types/settings";
import type { VectorStoreDefaults } from "@/types/rag";

async function view(enterprise: Enterprise, permissions: readonly Permission[]): Promise<CatalogSettingsView> {
  const routing = catalogRouting(enterprise);
  return {
    settings: {
      catalog_auto_routes: routing.autoRoutes,
      catalog_min_confidence: routing.minConfidence,
      catalog_jev: {
        enabled: enterprise.catalog_jev?.enabled === true,
        model: enterprise.catalog_jev?.model ?? DEFAULT_JEV_MODEL,
        api_key: "",
        clear_api_key: false,
      },
      vector_stores: normalizeVectorDefaults(enterprise.vector_stores),
    },
    jevKeySet: Boolean(enterprise.catalog_jev?.api_key),
    models: await enabledModelChoices(),
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

async function assertNewAliases(next: VectorStoreDefaults, previous: VectorStoreDefaults) {
  await assertModelRoles([
    { alias: next.embedding_model === previous.embedding_model ? "" : next.embedding_model, role: "embedding" },
    { alias: next.ocr_model === previous.ocr_model ? "" : next.ocr_model, role: "ocr" },
    { alias: next.rerank_model === previous.rerank_model ? "" : next.rerank_model, role: "rerank" },
  ]);
}

export async function loadCatalogSettings() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(await getEnterprise(), session.permissions);
}

export async function saveCatalogSettings(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = catalogSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const { catalog_jev: jevInput, ...rest } = parsed.data;
  const current = await getEnterprise();
  const apiKey = jevInput.clear_api_key ? "" : jevInput.api_key || current.catalog_jev?.api_key || "";
  if (jevInput.enabled && !apiKey) throw new Error("JEV_KEY_REQUIRED");
  await assertNewAliases(rest.vector_stores, normalizeVectorDefaults(current.vector_stores));
  const jev = { enabled: jevInput.enabled, model: jevInput.model || DEFAULT_JEV_MODEL };
  const enterprise = await patchEnterprise({ ...rest, catalog_jev: { ...jev, api_key: apiKey } });
  await writeAudit({
    actor: session.user.id,
    action: "settings.catalog",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { ...rest, catalog_jev: { ...jev, api_key_changed: Boolean(jevInput.api_key) || jevInput.clear_api_key } },
  });
  return view(enterprise, session.permissions);
}
