"use server";

import {
  beginPasskeyRegistration,
  beginTotpReplacement,
  cancelAccountTotpReplacement,
  changeAccountPassword,
  confirmAccountTotpReplacement,
  createOwnManagementKey,
  finishAccountPasskeyRegistration,
  loadOwnManagementKeys,
  loadSecurityOverview,
  removeAccountPasskey,
  renameAccountPasskey,
  restoreAccountCredentials,
  revokeAccountSession,
  revokeOtherAccountSessions,
  revokeOwnManagementKey,
  rotateAccountRecoveryCodes,
} from "@/lib/auth/account-console";
import { runAction } from "@/lib/http/action-result";

export async function loadSecurityOverviewAction(...args: Parameters<typeof loadSecurityOverview>) {
  return runAction(() => loadSecurityOverview(...args));
}

export async function restoreOwnCredentialsAction(...args: Parameters<typeof restoreAccountCredentials>) {
  return runAction(() => restoreAccountCredentials(...args));
}

export async function changePasswordAction(...args: Parameters<typeof changeAccountPassword>) {
  return runAction(() => changeAccountPassword(...args));
}

export async function startTotpReplacementAction(...args: Parameters<typeof beginTotpReplacement>) {
  return runAction(() => beginTotpReplacement(...args));
}

export async function confirmTotpReplacementAction(...args: Parameters<typeof confirmAccountTotpReplacement>) {
  return runAction(() => confirmAccountTotpReplacement(...args));
}

export async function cancelTotpReplacementAction(...args: Parameters<typeof cancelAccountTotpReplacement>) {
  return runAction(() => cancelAccountTotpReplacement(...args));
}

export async function regenerateRecoveryCodesAction(...args: Parameters<typeof rotateAccountRecoveryCodes>) {
  return runAction(() => rotateAccountRecoveryCodes(...args));
}

export async function revokeSessionAction(...args: Parameters<typeof revokeAccountSession>) {
  return runAction(() => revokeAccountSession(...args));
}

export async function revokeOtherSessionsAction(...args: Parameters<typeof revokeOtherAccountSessions>) {
  return runAction(() => revokeOtherAccountSessions(...args));
}

export async function startPasskeyRegistrationAction(...args: Parameters<typeof beginPasskeyRegistration>) {
  return runAction(() => beginPasskeyRegistration(...args));
}

export async function finishPasskeyRegistrationAction(...args: Parameters<typeof finishAccountPasskeyRegistration>) {
  return runAction(() => finishAccountPasskeyRegistration(...args));
}

export async function renamePasskeyAction(...args: Parameters<typeof renameAccountPasskey>) {
  return runAction(() => renameAccountPasskey(...args));
}

export async function removePasskeyAction(...args: Parameters<typeof removeAccountPasskey>) {
  return runAction(() => removeAccountPasskey(...args));
}

export async function loadManagementKeysAction(...args: Parameters<typeof loadOwnManagementKeys>) {
  return runAction(() => loadOwnManagementKeys(...args));
}

export async function createManagementKeyAction(...args: Parameters<typeof createOwnManagementKey>) {
  return runAction(() => createOwnManagementKey(...args));
}

export async function revokeManagementKeyAction(...args: Parameters<typeof revokeOwnManagementKey>) {
  return runAction(() => revokeOwnManagementKey(...args));
}
