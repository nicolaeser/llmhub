"use server";

import { runAction } from "@/lib/http/action-result";
import { createKey, loadKeysPage, revokeKey, rotateKey, updateKey } from "@/lib/keys/manage";
import { setBudget } from "@/lib/tenancy/budgets";

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
