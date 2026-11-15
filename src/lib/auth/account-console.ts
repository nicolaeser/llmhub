import "server-only";
import {
  cancelTotpReplacement,
  changeOwnPassword,
  confirmTotpReplacement,
  finishPasskeyRegistration,
  regenerateRecoveryCodes,
  removeOwnPasskey,
  renameOwnPasskey,
  revokeOtherSessions,
  revokeOwnSession,
  securityOverview,
  startPasskeyRegistration,
  startTotpReplacement,
} from "@/lib/auth/account-security";
import { restoreOwnCredentials } from "@/lib/auth/credentials";
import { requireSession } from "@/lib/auth/guards";
import { createManagementKey, managementKeysPayload, revokeManagementKey } from "@/lib/management/auth";
import type { AuthenticatedSession } from "@/types/auth";

async function overviewAfter(mutation: (session: AuthenticatedSession) => Promise<unknown>) {
  await mutation(await requireSession());
  return securityOverview(await requireSession());
}

export async function loadSecurityOverview() {
  return securityOverview(await requireSession());
}

export async function restoreAccountCredentials() {
  return overviewAfter((session) => restoreOwnCredentials(session));
}

export async function changeAccountPassword(input: unknown) {
  return overviewAfter((session) => changeOwnPassword(session, input));
}

export async function beginTotpReplacement(input: unknown) {
  return startTotpReplacement(await requireSession(), input);
}

export async function confirmAccountTotpReplacement(input: unknown) {
  return overviewAfter((session) => confirmTotpReplacement(session, input));
}

export async function cancelAccountTotpReplacement() {
  return overviewAfter((session) => cancelTotpReplacement(session));
}

export async function rotateAccountRecoveryCodes(input: unknown) {
  const { recoveryCodes } = await regenerateRecoveryCodes(await requireSession(), input);
  return { recoveryCodes, overview: await securityOverview(await requireSession()) };
}

export async function revokeAccountSession(input: unknown) {
  return overviewAfter((session) => revokeOwnSession(session, input));
}

export async function revokeOtherAccountSessions() {
  return overviewAfter((session) => revokeOtherSessions(session));
}

export async function beginPasskeyRegistration(input: unknown) {
  return startPasskeyRegistration(await requireSession(), input);
}

export async function finishAccountPasskeyRegistration(input: unknown) {
  return overviewAfter((session) => finishPasskeyRegistration(session, input));
}

export async function renameAccountPasskey(input: unknown) {
  return overviewAfter((session) => renameOwnPasskey(session, input));
}

export async function removeAccountPasskey(input: unknown) {
  return overviewAfter((session) => removeOwnPasskey(session, input));
}

export async function loadOwnManagementKeys() {
  return managementKeysPayload(await requireSession());
}

export async function createOwnManagementKey(input: unknown) {
  const session = await requireSession();
  const secret = await createManagementKey(session, input);
  return { secret, ...(await managementKeysPayload(session)) };
}

export async function revokeOwnManagementKey(id: unknown) {
  const session = await requireSession();
  await revokeManagementKey(session, id);
  return managementKeysPayload(session);
}
