import { useSyncExternalStore } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const passkeysSupported = () =>
  typeof window !== "undefined" && browserSupportsWebAuthn();

const noSubscription = () => () => {};

export function usePasskeySupport() {
  return useSyncExternalStore(noSubscription, passkeysSupported, () => false);
}

export class PasskeyCancelledError extends Error {
  constructor() {
    super("PASSKEY_CANCELLED");
    this.name = "PasskeyCancelledError";
  }
}

function cancelled(error: unknown) {
  return (
    (error instanceof WebAuthnError && error.code === "ERROR_CEREMONY_ABORTED") ||
    (error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError"))
  );
}

export async function passkeyAssertion(optionsJSON: PublicKeyCredentialRequestOptionsJSON) {
  try {
    return await startAuthentication({ optionsJSON });
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelledError();
    throw error;
  }
}

export async function passkeyAttestation(optionsJSON: PublicKeyCredentialCreationOptionsJSON) {
  try {
    return await startRegistration({ optionsJSON });
  } catch (error) {
    if (cancelled(error)) throw new PasskeyCancelledError();
    throw error;
  }
}
