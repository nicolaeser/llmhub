"use client";

import { useState, useTransition } from "react";
import { Button, Card, FieldError, Form, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useSecurityError } from "@/components/security/use-security-error";
import type { SecurityOverview } from "@/types/security";
import { changePasswordAction } from "../_action";

export default function PasswordCard({
  changedAt,
  onChange,
}: {
  changedAt: string | null;
  onChange: (overview: SecurityOverview) => void;
}) {
  const t = useTranslations("Account.password");
  const format = useFormatter();
  const errorText = useSecurityError();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, start] = useTransition();

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>
          {changedAt
            ? t("changedAt", { date: format.dateTime(new Date(changedAt), { dateStyle: "medium" }) })
            : t("neverChanged")}
        </Card.Description>
      </Card.Header>
      <Form
        validationBehavior="native"
        className="space-y-4"
        aria-label={t("title")}
        onSubmit={(event) => {
          event.preventDefault();
          start(async () => {
            const result = await changePasswordAction({ currentPassword, newPassword });
            if (isActionFail(result)) {
              toast.danger(errorText(result.error));
              return;
            }
            onChange(result);
            setCurrentPassword("");
            setNewPassword("");
            setConfirmation("");
            toast(t("changed"), { variant: "success" });
          });
        }}
      >
        <TextField fullWidth
          isRequired
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          isDisabled={pending}
        >
          <Label>{t("current")}</Label>
          <Input autoComplete="current-password" />
        </TextField>
        <TextField fullWidth
          isRequired
          type="password"
          minLength={10}
          value={newPassword}
          onChange={setNewPassword}
          isDisabled={pending}
        >
          <Label>{t("new")}</Label>
          <Input autoComplete="new-password" />
          <FieldError />
        </TextField>
        <TextField fullWidth
          isRequired
          type="password"
          value={confirmation}
          onChange={setConfirmation}
          isDisabled={pending}
          validate={(value) => (value === newPassword ? null : t("mismatch"))}
        >
          <Label>{t("confirm")}</Label>
          <Input autoComplete="new-password" />
          <FieldError />
        </TextField>
        <p className="text-xs text-muted">{t("hint")}</p>
        <Button type="submit" variant="secondary" isPending={pending}>
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("submit")}
            </>
          )}
        </Button>
      </Form>
    </Card>
  );
}
