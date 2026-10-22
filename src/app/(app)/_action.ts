"use server";

import { requireSession } from "@/lib/auth/guards";
import { setConsoleLocale } from "@/lib/auth/console-locale";
import { loadConsoleAccess, loadConsoleScope } from "@/lib/auth/console-scope";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { setWorkspace } from "@/lib/auth/workspace";
import { runAction } from "@/lib/http/action-result";
import { getEnterprise } from "@/lib/settings/enterprise";
import { checkForUpdate } from "@/lib/updates/update-check";
import { requestUpdaterCommand, setAutoUpdate } from "@/lib/updates/updater";

export async function setWorkspaceAction(orgId: string) {
  return runAction(() => setWorkspace(orgId));
}

export async function setLocaleAction(locale: string) {
  return runAction(() => setConsoleLocale(locale));
}

export async function loadConsoleScopeAction() {
  return runAction(() => loadConsoleScope());
}

export async function loadConsoleAccessAction() {
  return runAction(() => loadConsoleAccess());
}

export async function loadUpdateStatusAction() {
  return runAction(async () => {
    const session = await requireSession();
    const shown = hasPerm(session.permissions, PERMISSIONS.SETTINGS_READ);
    return checkForUpdate(shown && (await getEnterprise()).update_check !== false);
  });
}

export async function setAutoUpdateAction(...args: Parameters<typeof setAutoUpdate>) {
  return runAction(() => setAutoUpdate(...args));
}

export async function requestUpdaterAction(...args: Parameters<typeof requestUpdaterCommand>) {
  return runAction(() => requestUpdaterCommand(...args));
}
