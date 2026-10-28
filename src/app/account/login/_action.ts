"use server";

import { runAction } from "@/lib/http/action-result";
import { oidcIsReady, ssoOnlyActive } from "@/lib/auth/oidc";
import { providerName } from "@/lib/auth/oidc-presets";
import { passkeysAvailable } from "@/lib/auth/passkeys";
import { passwordResetEnabled } from "@/lib/auth/self-service";
import { ssoAccessHelp } from "@/lib/auth/sso-access";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import type { LoginContext } from "@/types/security";
import {
  cancelSignIn,
  completePasswordChange,
  confirmEnrollment,
  loginState,
  passkeySecondFactorOptions,
  passwordlessOptions,
  passwordSignIn,
  startEnrollment,
  verifyLoginSecondFactor,
  verifyPasskeySecondFactor,
  verifyPasswordless,
} from "@/lib/auth/sign-in";

export async function passwordSignInAction(input: unknown) {
  return runAction(() => passwordSignIn(input));
}

export async function loginContextAction() {
  return runAction(async (): Promise<LoginContext> => {
    const enterprise = await getEnterprise().catch(() => null);
    const ssoOnly = enterprise ? ssoOnlyActive(enterprise.oidc) : false;
    const ssoEnabled = enterprise ? oidcIsReady(enterprise.oidc) : false;
    return {
      step: await loginState(),
      ssoEnabled,
      ssoProvider: enterprise && ssoEnabled ? providerName(normalizeOidc(enterprise.oidc)) : "",
      ssoOnly,
      passkeysEnabled: passkeysAvailable(),
      registrationEnabled: enterprise?.registration_enabled === true && !ssoOnly,
      passwordResetEnabled: passwordResetEnabled(),
    };
  });
}

export async function ssoAccessHelpAction() {
  return runAction(() => ssoAccessHelp());
}

export async function cancelSignInAction() {
  return runAction(() => cancelSignIn());
}

export async function startEnrollmentAction() {
  return runAction(() => startEnrollment());
}

export async function confirmEnrollmentAction(input: unknown) {
  return runAction(() => confirmEnrollment(input));
}

export async function verifySecondFactorAction(input: unknown) {
  return runAction(() => verifyLoginSecondFactor(input));
}

export async function passkeySecondFactorOptionsAction() {
  return runAction(() => passkeySecondFactorOptions());
}

export async function verifyPasskeySecondFactorAction(input: unknown) {
  return runAction(() => verifyPasskeySecondFactor(input));
}

export async function passwordlessOptionsAction() {
  return runAction(() => passwordlessOptions());
}

export async function verifyPasswordlessAction(input: unknown) {
  return runAction(() => verifyPasswordless(input));
}

export async function completePasswordChangeAction(input: unknown) {
  return runAction(() => completePasswordChange(input));
}
