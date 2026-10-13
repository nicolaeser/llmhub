"use server";

import { grantedPermissions } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { runAction } from "@/lib/http/action-result";
import { loadReplay } from "@/lib/gateway/request-logs/replay";
import { loadApiRef } from "@/lib/keys/api-reference";
import { loadAliases } from "@/lib/models/aliases";

export async function loadDeveloperTabsAction() {
  return runAction(() => grantedPermissions([PERMISSIONS.PLAYGROUND_USE, PERMISSIONS.KEYS_READ]));
}

export async function loadReplayAction(...args: Parameters<typeof loadReplay>) {
  return runAction(() => loadReplay(...args));
}

export async function loadAliasesAction(...args: Parameters<typeof loadAliases>) {
  return runAction(() => loadAliases(...args));
}

export async function loadApiRefAction(...args: Parameters<typeof loadApiRef>) {
  return runAction(() => loadApiRef(...args));
}
