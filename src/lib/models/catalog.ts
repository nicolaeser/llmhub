import "server-only";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assignEntry, setEntryActive, setGroupActive, setGroupAutoRoutes } from "@/lib/gateway/catalog/catalog-routes";
import { refreshCatalogNow } from "@/lib/gateway/catalog/catalog-tasks";
import { loadCatalogView } from "@/lib/gateway/catalog/catalog-view";
import {
  catalogEntryActiveSchema,
  catalogEntryAssignSchema,
  catalogGroupActiveSchema,
  catalogGroupAutoRoutesSchema,
} from "@/schemas/model-catalog";
import type { AuthenticatedSession } from "@/types/auth";
import type { CatalogView } from "@/types/model-catalog";

async function view(session: AuthenticatedSession): Promise<CatalogView> {
  return {
    ...(await loadCatalogView()),
    canManage: hasPerm(session.permissions, PERMISSIONS.MODELS_MANAGE),
    canConfigure: hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

async function manage() {
  return requirePlatformPermission(PERMISSIONS.MODELS_MANAGE);
}

export async function loadCatalog() {
  return view(await requirePlatformPermission(PERMISSIONS.MODELS_READ));
}

export async function refreshCatalog() {
  const session = await manage();
  await refreshCatalogNow(session.user.id);
  return view(session);
}

export async function setCatalogGroupActive(raw: unknown) {
  const session = await manage();
  const parsed = catalogGroupActiveSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  await setGroupActive(session.user.id, parsed.data.alias, parsed.data.active);
  return view(session);
}

export async function setCatalogGroupAutoRoutes(raw: unknown) {
  const session = await manage();
  const parsed = catalogGroupAutoRoutesSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  await setGroupAutoRoutes(session.user.id, parsed.data.alias, parsed.data.autoRoutes);
  return view(session);
}

export async function setCatalogEntryActive(raw: unknown) {
  const session = await manage();
  const parsed = catalogEntryActiveSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const { active, ...ref } = parsed.data;
  await setEntryActive(session.user.id, ref, active);
  return view(session);
}

export async function assignCatalogEntry(raw: unknown) {
  const session = await manage();
  const parsed = catalogEntryAssignSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const { alias, ...ref } = parsed.data;
  await assignEntry(session.user.id, ref, alias);
  return view(session);
}
