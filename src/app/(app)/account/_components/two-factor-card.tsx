"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Modal, Spinner, toast, useOverlayState } from "@heroui/react";
import { KeyRound, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { RecoveryCodesPanel } from "@/components/security/recovery-codes-panel";
import { SecondFactorInput } from "@/components/security/second-factor-input";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { TotpEnrollmentPanel } from "@/components/security/totp-enrollment";
import { useSecurityError } from "@/components/security/use-security-error";
import type { SecondFactorProof, SecurityOverview, TotpEnrollment } from "@/types/security";
import {
  cancelTotpReplacementAction,
  confirmTotpReplacementAction,
  regenerateRecoveryCodesAction,
  startTotpReplacementAction,
} from "../_action";

const LOW_RECOVERY_CODES = 3;

export default function TwoFactorCard({
  twoFactor,
  onChange,
}: {
  twoFactor: SecurityOverview["twoFactor"];
  onChange: (overview: SecurityOverview) => void;
}) {
  const t = useTranslations("Account.twoFactor");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const errorText = useSecurityError();
  const replaceStepUp = useOverlayState();
  const regenerateStepUp = useOverlayState();
  const replaceModal = useOverlayState();
  const codesModal = useOverlayState();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [value, setValue] = useState<SecondFactorProof>({ method: "totp", code: "" });
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, start] = useTransition();
  const low = twoFactor.recoveryCodesRemaining <= LOW_RECOVERY_CODES;

  function activate(code: string) {
    setError(null);
    start(async () => {
      const result = await confirmTotpReplacementAction({ code });
      if (isActionFail(result)) {
        setError(result.error);
        setValue({ method: "totp", code: "" });
        return;
      }
      onChange(result);
      setEnrollment(null);
      replaceModal.close();
      toast(t("replaced"), { variant: "success" });
    });
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Card.Header className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </Card.Header>
        <Chip size="sm" variant="soft" color={twoFactor.enabledAt ? "success" : "warning"}>
          {twoFactor.enabledAt
            ? t("activeSince", {
                date: format.dateTime(new Date(twoFactor.enabledAt), { dateStyle: "medium" }),
              })
            : t("inactive")}
        </Chip>
      </div>
      <Card variant="secondary" className="flex-row flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className={`text-sm ${low ? "text-warning" : "text-muted"}`}>
          {t("recoveryRemaining", {
            count: twoFactor.recoveryCodesRemaining,
            total: twoFactor.recoveryCodesTotal,
          })}
        </p>
        <Button size="sm" variant="secondary" onPress={regenerateStepUp.open}>
          <RefreshCw size={14} aria-hidden />
          {t("regenerate")}
        </Button>
      </Card>
      <Card.Footer className="flex-wrap gap-2">
        <Button variant="secondary" onPress={replaceStepUp.open}>
          <KeyRound size={16} aria-hidden />
          {t("replace")}
        </Button>
      </Card.Footer>

      <StepUpDialog
        state={replaceStepUp}
        title={t("replace")}
        description={t("replaceStepUp")}
        confirmLabel={tCommon("continue")}
        onConfirm={async (code) => {
          const result = await startTotpReplacementAction({ code });
          if (isActionFail(result)) return result.error;
          setEnrollment(result);
          setValue({ method: "totp", code: "" });
          setError(null);
          replaceModal.open();
          return null;
        }}
      />

      <StepUpDialog
        state={regenerateStepUp}
        title={t("regenerate")}
        description={t("regenerateStepUp")}
        confirmLabel={t("regenerate")}
        onConfirm={async (code) => {
          const result = await regenerateRecoveryCodesAction({ code });
          if (isActionFail(result)) return result.error;
          onChange(result.overview);
          setCodes(result.recoveryCodes);
          setAcknowledged(false);
          codesModal.open();
          return null;
        }}
      />

      <Modal state={replaceModal}>
        <Modal.Backdrop isDismissable={false}>
          <Modal.Container>
            <Modal.Dialog className="max-w-2xl">
              <Modal.Header>
                <Modal.Heading>{t("replaceTitle")}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-5">
                {enrollment ? <TotpEnrollmentPanel enrollment={enrollment} /> : null}
                <SecondFactorInput
                  value={value}
                  onChange={(next) => {
                    setValue(next);
                    setError(null);
                  }}
                  onComplete={activate}
                  isDisabled={pending}
                  isInvalid={Boolean(error)}
                  allowRecovery={false}
                  autoFocus
                />
                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Description>{errorText(error)}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="tertiary"
                  isDisabled={pending}
                  onPress={() => {
                    replaceModal.close();
                    setEnrollment(null);
                    cancelTotpReplacementAction().then((result) => {
                      if (!isActionFail(result)) onChange(result);
                    });
                  }}
                >
                  {tCommon("cancel")}
                </Button>
                <Button
                  isPending={pending}
                  isDisabled={!/^\d{6}$/.test(value.code)}
                  onPress={() => activate(value.code)}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : null}
                      {t("activate")}
                    </>
                  )}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal state={codesModal}>
        <Modal.Backdrop isDismissable={false}>
          <Modal.Container>
            <Modal.Dialog className="max-w-lg">
              <Modal.Header>
                <Modal.Heading>{t("newCodesTitle")}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <RecoveryCodesPanel
                  codes={codes}
                  acknowledged={acknowledged}
                  onAcknowledgedChange={setAcknowledged}
                />
              </Modal.Body>
              <Modal.Footer>
                <Button
                  isDisabled={!acknowledged}
                  onPress={() => {
                    codesModal.close();
                    setCodes([]);
                  }}
                >
                  {tCommon("done")}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </Card>
  );
}
