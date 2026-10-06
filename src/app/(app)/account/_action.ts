"use server";

import { requireSession } from "@/lib/auth/guards";
import { runAction } from "@/lib/http/action-result";
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
import {
  createManagementKey,
  managementKeysPayload,
  revokeManagementKey,
} from "@/lib/management/auth";
import type { AuthenticatedSession } from "@/types/auth";

async function overviewAfter(mutation: (session: AuthenticatedSession) => Promise<unknown>) {
  await mutation(await requireSession());
  return securityOverview(await requireSession());
}

export async function loadSecurityOverviewAction() {
  return runAction(async () => securityOverview(await requireSession()));
}

export async function changePasswordAction(input: unknown) {
  return runAction(() => overviewAfter((session) => changeOwnPassword(session, input)));
}

export async function startTotpReplacementAction(input: unknown) {
  return runAction(async () => startTotpReplacement(await requireSession(), input));
}

export async function confirmTotpReplacementAction(input: unknown) {
  return runAction(() => overviewAfter((session) => confirmTotpReplacement(session, input)));
}

export async function cancelTotpReplacementAction() {
  return runAction(() => overviewAfter((session) => cancelTotpReplacement(session)));
}

export async function regenerateRecoveryCodesAction(input: unknown) {
  return runAction(async () => {
    const { recoveryCodes } = await regenerateRecoveryCodes(await requireSession(), input);
    return { recoveryCodes, overview: await securityOverview(await requireSession()) };
  });
}

export async function revokeSessionAction(input: unknown) {
  return runAction(() => overviewAfter((session) => revokeOwnSession(session, input)));
}

export async function revokeOtherSessionsAction() {
  return runAction(() => overviewAfter((session) => revokeOtherSessions(session)));
}

export async function startPasskeyRegistrationAction(input: unknown) {
  return runAction(async () => startPasskeyRegistration(await requireSession(), input));
}

export async function finishPasskeyRegistrationAction(input: unknown) {
  return runAction(() => overviewAfter((session) => finishPasskeyRegistration(session, input)));
}

export async function renamePasskeyAction(input: unknown) {
  return runAction(() => overviewAfter((session) => renameOwnPasskey(session, input)));
}

export async function removePasskeyAction(input: unknown) {
  return runAction(() => overviewAfter((session) => removeOwnPasskey(session, input)));
}

export async function loadManagementKeysAction() {
  return runAction(async () => managementKeysPayload(await requireSession()));
}

export async function createManagementKeyAction(input: unknown) {
  return runAction(async () => {
    const session = await requireSession();
    const secret = await createManagementKey(session, input);
    return { secret, ...(await managementKeysPayload(session)) };
  });
}

export async function revokeManagementKeyAction(id: unknown) {
  return runAction(async () => {
    const session = await requireSession();
    await revokeManagementKey(session, id);
    return managementKeysPayload(session);
  });
}
