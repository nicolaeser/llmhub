"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Modal, Spinner, type useOverlayState } from "@heroui/react";
import {
  SecondFactorInput,
  emptySecondFactor,
  secondFactorComplete,
} from "@/components/security/second-factor-input";
import { useSecurityError } from "@/components/security/use-security-error";
import type { SecondFactorProof } from "@/types/security";

export function StepUpDialog({
  state,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
}: {
  state: ReturnType<typeof useOverlayState>;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (code: string) => Promise<string | null>;
}) {
  const t = useTranslations("Security");
  const tCommon = useTranslations("Common");
  const errorText = useSecurityError();
  const [value, setValue] = useState<SecondFactorProof>(emptySecondFactor);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(code: string, close: () => void) {
    setError(null);
    start(async () => {
      const failure = await onConfirm(code);
      if (failure) {
        setError(failure);
        setValue((current) => ({ ...current, code: "" }));
        return;
      }
      setValue(emptySecondFactor);
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{title}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="space-y-4">
                  <p className="text-sm text-muted">{description}</p>
                  <SecondFactorInput
                    value={value}
                    onChange={(next) => {
                      setValue(next);
                      setError(null);
                    }}
                    onComplete={(code) => submit(code, close)}
                    isDisabled={pending}
                    isInvalid={Boolean(error)}
                    autoFocus
                    label={t("stepUpLabel")}
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
                    onPress={() => {
                      setValue(emptySecondFactor);
                      setError(null);
                      close();
                    }}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    variant={danger ? "danger" : "primary"}
                    isPending={pending}
                    isDisabled={!secondFactorComplete(value)}
                    onPress={() => submit(value.code, close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {confirmLabel}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
