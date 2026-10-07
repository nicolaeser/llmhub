"use server";

import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import {
  assignEntry,
  loadCatalogView,
  refreshCatalog,
  setEntryActive,
  setGroupActive,
  setGroupAutoRoutes,
} from "@/lib/gateway/catalog-sync";
import {
  catalogEntryActiveSchema,
  catalogEntryAssignSchema,
  catalogGroupActiveSchema,
  catalogGroupAutoRoutesSchema,
} from "@/schemas/model-catalog";
import type { CatalogView } from "@/types/model-catalog";

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
    await refreshCatalog({ actor: session.user.id, force: true });
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
