"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { RecoveryCodesPanel } from "@/components/security/recovery-codes-panel";
import { SecondFactorInput } from "@/components/security/second-factor-input";
import { TotpEnrollmentPanel } from "@/components/security/totp-enrollment";
import { useSecurityError } from "@/components/security/use-security-error";
import type { LoginResult, SecondFactorProof, TotpEnrollment } from "@/types/security";
import { cancelSignInAction, confirmEnrollmentAction, startEnrollmentAction } from "../_action";

export default function EnrollmentStep({
  onResult,
  onRestart,
}: {
  onResult: (result: LoginResult) => void;
  onRestart: (expired: boolean) => void;
}) {
  const t = useTranslations("Auth.login");
  const errorText = useSecurityError();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [value, setValue] = useState<SecondFactorProof>({ method: "totp", code: "" });
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ codes: string[]; next: LoginResult } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [starting, startSetup] = useTransition();
  const [activating, startActivation] = useTransition();
  const [leaving, startLeaving] = useTransition();
  const busy = starting || activating || leaving;

  function fail(code: string) {
    if (code === "LOGIN_CHALLENGE_EXPIRED") {
      onRestart(true);
      return;
    }
    setError(code);
  }

  function begin() {
    setError(null);
    startSetup(async () => {
      const result = await startEnrollmentAction();
      if (isActionFail(result)) {
        fail(result.error);
        return;
      }
      setEnrollment(result);
    });
  }

  function activate(code: string) {
    setError(null);
    startActivation(async () => {
      const result = await confirmEnrollmentAction({ code });
      if (isActionFail(result)) {
        fail(result.error);
        setValue({ method: "totp", code: "" });
        return;
      }
      setConfirmed({ codes: result.recoveryCodes, next: result.next });
    });
  }

  if (confirmed) {
    return (
      <div className="space-y-5">
        <RecoveryCodesPanel
          codes={confirmed.codes}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
        />
        <Button
          fullWidth
          size="lg"
          isDisabled={!acknowledged}
          onPress={() => onResult(confirmed.next)}
        >
          {t("continue")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {enrollment ? (
        <>
          <TotpEnrollmentPanel enrollment={enrollment} />
          <SecondFactorInput
            value={value}
            onChange={(updated) => {
              setValue(updated);
              setError(null);
            }}
            onComplete={activate}
            isDisabled={busy}
            isInvalid={Boolean(error)}
            allowRecovery={false}
            autoFocus
          />
        </>
      ) : (
        <p className="text-sm leading-relaxed text-muted">{t("enrollIntro")}</p>
      )}
      {error ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{errorText(error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {enrollment ? (
        <Button
          fullWidth
          size="lg"
          isPending={activating}
          isDisabled={busy || !/^\d{6}$/.test(value.code)}
          onPress={() => activate(value.code)}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("activate")}
            </>
          )}
        </Button>
      ) : (
        <Button
          fullWidth
          size="lg"
          isPending={starting}
          isDisabled={busy}
          onPress={begin}
        >
          {({ isPending }) => (
            <>
              {isPending ? (
                <Spinner color="current" size="sm" />
              ) : (
                <ShieldCheck size={16} aria-hidden />
              )}
              {t("startEnrollment")}
            </>
          )}
        </Button>
      )}
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
