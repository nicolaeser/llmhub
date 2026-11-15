"use server";

import { setConsoleLocale } from "@/lib/auth/console-locale";
import { loadConsoleAccess, loadConsoleScope } from "@/lib/auth/console-scope";
import { setWorkspace } from "@/lib/auth/workspace";
import { runAction } from "@/lib/http/action-result";
import { loadUpdateStatus } from "@/lib/updates/update-check";
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

export async function loadUpdateStatusAction(...args: Parameters<typeof loadUpdateStatus>) {
  return runAction(() => loadUpdateStatus(...args));
}

export async function setAutoUpdateAction(...args: Parameters<typeof setAutoUpdate>) {
  return runAction(() => setAutoUpdate(...args));
}

export async function requestUpdaterAction(...args: Parameters<typeof requestUpdaterCommand>) {
  return runAction(() => requestUpdaterCommand(...args));
}
