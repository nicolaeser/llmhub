"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import {
  SecondFactorInput,
  emptySecondFactor,
  secondFactorComplete,
} from "@/components/security/second-factor-input";
import { useSecurityError } from "@/components/security/use-security-error";
import {
  PasskeyCancelledError,
  passkeyAssertion,
  usePasskeySupport,
} from "@/components/security/webauthn";
import type { LoginMethod, LoginResult, SecondFactorProof } from "@/types/security";
import {
  cancelSignInAction,
  passkeySecondFactorOptionsAction,
  verifyPasskeySecondFactorAction,
  verifySecondFactorAction,
} from "../_action";

const RESTART_CODES = new Set(["LOGIN_CHALLENGE_EXPIRED", "SECOND_FACTOR_LOCKED"]);

export default function SecondFactorStep({
  methods,
  onResult,
  onRestart,
}: {
  methods: LoginMethod[];
  onResult: (result: LoginResult) => void;
  onRestart: (expired: boolean) => void;
}) {
  const t = useTranslations("Auth.login");
  const errorText = useSecurityError();
  const browserPasskeys = usePasskeySupport();
  const [value, setValue] = useState<SecondFactorProof>(emptySecondFactor);
  const [error, setError] = useState<string | null>(null);
  const [verifying, startVerify] = useTransition();
  const [passkeyPending, startPasskey] = useTransition();
  const [leaving, startLeaving] = useTransition();
  const busy = verifying || passkeyPending || leaving;
  const passkeyAllowed = methods.includes("passkey") && browserPasskeys;

  function fail(code: string) {
    if (code === "LOGIN_CHALLENGE_EXPIRED") {
      onRestart(true);
      return;
    }
    setError(code);
    setValue((current) => ({ ...current, code: "" }));
    if (RESTART_CODES.has(code)) onRestart(false);
  }

  function submit(proof: SecondFactorProof) {
    setError(null);
    startVerify(async () => {
      const result = await verifySecondFactorAction(proof);
      if (isActionFail(result)) {
        fail(result.error);
        return;
      }
      onResult(result);
    });
  }

  function signInWithPasskey() {
    setError(null);
    startPasskey(async () => {
      const options = await passkeySecondFactorOptionsAction();
      if (isActionFail(options)) {
        fail(options.error);
        return;
      }
      try {
        const response = await passkeyAssertion(options);
        const result = await verifyPasskeySecondFactorAction({ response });
        if (isActionFail(result)) {
          fail(result.error);
          return;
        }
        onResult(result);
      } catch (caught) {
        if (caught instanceof PasskeyCancelledError) return;
        setError("PASSKEY_VERIFICATION_FAILED");
      }
    });
  }

  return (
    <div className="space-y-5">
      <SecondFactorInput
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        onComplete={(code) => submit({ method: "totp", code })}
        isDisabled={busy}
        isInvalid={Boolean(error)}
        autoFocus
      />
      {error ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{errorText(error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Button
        fullWidth
        size="lg"
        isPending={verifying}
        isDisabled={busy || !secondFactorComplete(value)}
        onPress={() => submit(value)}
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {t("verify")}
          </>
        )}
      </Button>
      {passkeyAllowed ? (
        <Button
          variant="secondary"
          fullWidth
          size="lg"
          isPending={passkeyPending}
          isDisabled={busy}
          onPress={signInWithPasskey}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : <KeyRound size={16} aria-hidden />}
              {t("usePasskey")}
            </>
          )}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        className="w-full"
        isPending={leaving}
        isDisabled={busy}
        onPress={() =>
          startLeaving(async () => {
            await cancelSignInAction();
            onRestart(false);
          })
        }
      >
        {t("differentAccount")}
      </Button>
    </div>
  );
}
