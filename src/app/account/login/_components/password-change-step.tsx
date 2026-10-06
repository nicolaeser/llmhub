"use client";

import { useState, useTransition } from "react";
import { Alert, Button, FieldError, Form, Input, Label, Spinner, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useSecurityError } from "@/components/security/use-security-error";
import type { LoginResult } from "@/types/security";
import { completePasswordChangeAction } from "../_action";

export default function PasswordChangeStep({
  onResult,
  onRestart,
}: {
  onResult: (result: LoginResult) => void;
  onRestart: (expired: boolean) => void;
}) {
  const t = useTranslations("Auth.login");
  const errorText = useSecurityError();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Form
      validationBehavior="native"
      className="space-y-5"
      aria-label={t("changePassword")}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await completePasswordChangeAction({ password });
          if (isActionFail(result)) {
            if (result.error === "LOGIN_CHALLENGE_EXPIRED") {
              onRestart(true);
              return;
            }
            setError(result.error);
            return;
          }
          onResult(result);
        });
      }}
    >
      <TextField fullWidth
        isRequired
        type="password"
        value={password}
        onChange={setPassword}
        isDisabled={pending}
        minLength={10}
      >
        <Label>{t("newPassword")}</Label>
        <Input autoComplete="new-password" />
        <FieldError />
      </TextField>
      <TextField fullWidth
        isRequired
        type="password"
        value={confirmation}
        onChange={setConfirmation}
        isDisabled={pending}
        validate={(value) => (value === password ? null : t("passwordMismatch"))}
      >
        <Label>{t("confirmPassword")}</Label>
        <Input autoComplete="new-password" />
        <FieldError />
      </TextField>
      <p className="text-xs text-muted">{t("passwordRules")}</p>
      {error ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{errorText(error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Button
        type="submit"
        fullWidth
        size="lg"
        isPending={pending}
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {t("changePassword")}
          </>
        )}
      </Button>
    </Form>
  );
}
