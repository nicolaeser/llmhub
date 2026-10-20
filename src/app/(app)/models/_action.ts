"use server";

import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { assignEntry, setEntryActive, setGroupActive, setGroupAutoRoutes } from "@/lib/gateway/catalog/catalog-routes";
import { loadCatalogView } from "@/lib/gateway/catalog/catalog-view";
import { refreshCatalogNow } from "@/lib/gateway/catalog/catalog-tasks";
import {
  createModelGroup,
  deleteModelGroup,
  loadModels,
  setModelGroupEnabled,
  updateModelGroup,
} from "@/lib/models/groups";
import {
  catalogEntryActiveSchema,
  catalogEntryAssignSchema,
  catalogGroupActiveSchema,
  catalogGroupAutoRoutesSchema,
} from "@/schemas/model-catalog";
import type { CatalogView } from "@/types/model-catalog";

export async function loadModelsAction(...args: Parameters<typeof loadModels>) {
  return runAction(() => loadModels(...args));
}

export async function createModelGroupAction(...args: Parameters<typeof createModelGroup>) {
  return runAction(() => createModelGroup(...args));
}

export async function updateModelGroupAction(...args: Parameters<typeof updateModelGroup>) {
  return runAction(() => updateModelGroup(...args));
}

export async function setModelGroupEnabledAction(...args: Parameters<typeof setModelGroupEnabled>) {
  return runAction(() => setModelGroupEnabled(...args));
}

export async function deleteModelGroupAction(...args: Parameters<typeof deleteModelGroup>) {
  return runAction(() => deleteModelGroup(...args));
}

async function view(canManage: boolean): Promise<CatalogView> {
  return { ...(await loadCatalogView()), canManage };
}

async function manage() {
  return requirePermission(PERMISSIONS.MODELS_MANAGE);
}

export async function loadCatalogAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.MODELS_READ);
    return view(hasPerm(session.permissions, PERMISSIONS.MODELS_MANAGE));
  });
}

export async function refreshCatalogAction() {
  return runAction(async () => {
    const session = await manage();
    await refreshCatalogNow(session.user.id);
    return view(true);
  });
}

export async function setCatalogGroupActiveAction(raw: unknown) {
  return runAction(async () => {
    const session = await manage();
    const parsed = catalogGroupActiveSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    await setGroupActive(session.user.id, parsed.data.alias, parsed.data.active);
    return view(true);
  });
}

export async function setCatalogGroupAutoRoutesAction(raw: unknown) {
  return runAction(async () => {
    const session = await manage();
    const parsed = catalogGroupAutoRoutesSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    await setGroupAutoRoutes(session.user.id, parsed.data.alias, parsed.data.autoRoutes);
    return view(true);
  });
}

export async function setCatalogEntryActiveAction(raw: unknown) {
  return runAction(async () => {
    const session = await manage();
    const parsed = catalogEntryActiveSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    const { active, ...ref } = parsed.data;
    await setEntryActive(session.user.id, ref, active);
    return view(true);
  });
}

export async function assignCatalogEntryAction(raw: unknown) {
  return runAction(async () => {
    const session = await manage();
    const parsed = catalogEntryAssignSchema.safeParse(raw);
    if (!parsed.success) return actionFail("VALIDATION");
    const { alias, ...ref } = parsed.data;
    await assignEntry(session.user.id, ref, alias);
    return view(true);
  });
}
