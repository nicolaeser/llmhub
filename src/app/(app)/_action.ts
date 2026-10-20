"use server";

import { requireAuth } from "@/lib/auth/guards";
import { loadConsoleScope } from "@/lib/auth/console-scope";
import { setWorkspace } from "@/lib/auth/workspace";
import { runAction } from "@/lib/http/action-result";
import { getEnterprise } from "@/lib/settings/enterprise";
import { checkForUpdate } from "@/lib/updates/update-check";
import { requestUpdaterCommand, setAutoUpdate } from "@/lib/updates/updater";

export async function setWorkspaceAction(orgId: string) {
  return runAction(() => setWorkspace(orgId));
}

export async function loadConsoleScopeAction() {
  return runAction(() => loadConsoleScope());
}

export async function loadUpdateStatusAction() {
  return runAction(async () => {
    await requireAuth();
    return checkForUpdate((await getEnterprise()).update_check !== false);
  });
}

export async function setAutoUpdateAction(...args: Parameters<typeof setAutoUpdate>) {
  return runAction(() => setAutoUpdate(...args));
}

export async function requestUpdaterAction(...args: Parameters<typeof requestUpdaterCommand>) {
  return runAction(() => requestUpdaterCommand(...args));
}
