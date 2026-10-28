"use server";

import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeysPage, pauseKey, resumeKey, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { loadKeyMcpAccess, saveKeyMcpAccess } from "@/lib/mcp/key-access";
import { addBoost, loadBudget, removeBoost, setBudget } from "@/lib/tenancy/budgets";
import type { BoostInput, BudgetInput, BudgetRef } from "@/types/structure";

export async function loadKeysPageAction(...args: Parameters<typeof loadKeysPage>) {
  return runAction(() => loadKeysPage(...args));
}

export async function createKeyAction(...args: Parameters<typeof createKey>) {
  return runAction(() => createKey(...args));
}

export async function updateKeyAction(...args: Parameters<typeof updateKey>) {
  return runAction(() => updateKey(...args));
}

export async function pauseKeyAction(...args: Parameters<typeof pauseKey>) {
  return runAction(() => pauseKey(...args));
}

export async function resumeKeyAction(...args: Parameters<typeof resumeKey>) {
  return runAction(() => resumeKey(...args));
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

export async function loadKeyMcpAccessAction(...args: Parameters<typeof loadKeyMcpAccess>) {
  return runAction(() => loadKeyMcpAccess(...args));
}

export async function saveKeyMcpAccessAction(...args: Parameters<typeof saveKeyMcpAccess>) {
  return runAction(() => saveKeyMcpAccess(...args));
}
