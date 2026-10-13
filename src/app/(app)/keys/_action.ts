"use server";

import { grantedPermissions } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeysPage, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import {
  createTemplate,
  deleteTemplate,
  loadTemplates,
  updateTemplate,
} from "@/lib/models/templates";
import { setBudget } from "@/lib/tenancy/budgets";

export async function loadKeyTabsAction() {
  return runAction(() => grantedPermissions([PERMISSIONS.KEYS_READ, PERMISSIONS.MODELS_READ]));
}

export async function loadKeysPageAction(...args: Parameters<typeof loadKeysPage>) {
  return runAction(() => loadKeysPage(...args));
}

export async function createKeyAction(...args: Parameters<typeof createKey>) {
  return runAction(() => createKey(...args));
}

export async function updateKeyAction(...args: Parameters<typeof updateKey>) {
  return runAction(() => updateKey(...args));
}

export async function rotateKeyAction(...args: Parameters<typeof rotateKey>) {
  return runAction(() => rotateKey(...args));
}

export async function revokeKeyAction(...args: Parameters<typeof revokeKey>) {
  return runAction(() => revokeKey(...args));
}

export async function setBudgetAction(...args: Parameters<typeof setBudget>) {
  return runAction(() => setBudget(...args));
}

export async function loadTemplatesAction(...args: Parameters<typeof loadTemplates>) {
  return runAction(() => loadTemplates(...args));
}

export async function createTemplateAction(...args: Parameters<typeof createTemplate>) {
  return runAction(() => createTemplate(...args));
}

export async function updateTemplateAction(...args: Parameters<typeof updateTemplate>) {
  return runAction(() => updateTemplate(...args));
}

export async function deleteTemplateAction(...args: Parameters<typeof deleteTemplate>) {
  return runAction(() => deleteTemplate(...args));
}
