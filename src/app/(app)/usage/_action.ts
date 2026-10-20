"use server";

import { grantedPermissions } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { runAction } from "@/lib/http/action-result";
import { deleteMarkup, loadMarkups, saveMarkup } from "@/lib/pricing/markups";
import { loadUsage } from "@/lib/usage/dashboard";
import { loadUsageToday } from "@/lib/usage/usage-today";

export async function loadUsageTabsAction() {
  return runAction(() => grantedPermissions([PERMISSIONS.SPEND_READ, PERMISSIONS.PRICING_READ]));
}

export async function loadUsageAction(...args: Parameters<typeof loadUsage>) {
  return runAction(() => loadUsage(...args));
}

export async function loadUsageTodayAction() {
  return runAction(() => loadUsageToday());
}

export async function loadMarkupsAction(...args: Parameters<typeof loadMarkups>) {
  return runAction(() => loadMarkups(...args));
}

export async function saveMarkupAction(...args: Parameters<typeof saveMarkup>) {
  return runAction(() => saveMarkup(...args));
}

export async function deleteMarkupAction(...args: Parameters<typeof deleteMarkup>) {
  return runAction(() => deleteMarkup(...args));
}
