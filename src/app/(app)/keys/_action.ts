"use server";

import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeysPage, loadKeyTabs, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import {
  createTemplate,
  deleteTemplate,
  loadTemplates,
  updateTemplate,
} from "@/lib/models/templates";
import { addBoost, loadBudget, removeBoost, setBudget } from "@/lib/tenancy/budgets";
import type { BoostInput, BudgetInput, BudgetRef } from "@/types/structure";

export async function loadKeyTabsAction() {
  return runAction(() => loadKeyTabs());
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

export async function loadBudgetAction(input: BudgetRef) {
  return runAction(() => loadBudget({ ...input, kind: "key" }));
}

export async function setBudgetAction(input: BudgetInput) {
  return runAction(() => setBudget({ ...input, kind: "key" }));
}

export async function addBoostAction(input: BoostInput) {
  return runAction(() => addBoost({ ...input, kind: "key" }));
}

export async function removeBoostAction(boostId: string) {
  return runAction(() => removeBoost(boostId, "key"));
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

export async function loadKeyMcpAccessAction(...args: Parameters<typeof loadKeyMcpAccess>) {
  return runAction(() => loadKeyMcpAccess(...args));
}

export async function saveKeyMcpAccessAction(...args: Parameters<typeof saveKeyMcpAccess>) {
  return runAction(() => saveKeyMcpAccess(...args));
}
