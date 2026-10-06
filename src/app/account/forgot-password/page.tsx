"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Form, Input, Label, Skeleton, Spinner, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import AccountShell from "@/app/account/_components/account-shell";
import { isActionFail } from "@/lib/http/action-result";
import { passwordResetContextAction } from "./_action";

export default function ForgotPasswordPage() {
  const t = useTranslations("Auth.forgot");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    passwordResetContextAction().then((result) => {
      setEnabled(!isActionFail(result) && result.enabled);
    });
  }, []);

  return (
    <AccountShell
      title={t.rich("heading", {
        lead: (chunks) => chunks,
        accent: (chunks) => <span className="text-muted">{chunks}</span>,
      })}
      subtitle={t("subtitle")}
      footer={
        <Link href="/account/login" className="text-accent">
          {t("back")}
        </Link>
      }
    >
      {enabled === null ? (
        <div aria-busy className="space-y-5">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : !enabled ? (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("disabledTitle")}</Alert.Title>
            <Alert.Description>{t("disabled")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : sent ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("sent")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <Form
          validationBehavior="native"
          className="space-y-5"
          aria-label={t("submit")}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            start(async () => {
              const response = await fetch("/internal-api/account/forgot-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
              }).catch(() => null);
              if (response?.ok) {
                setSent(true);
                return;
              }
              const data = (await response?.json().catch(() => null)) as { code?: string } | null;
              setError(data?.code ?? "other");
            });
          }}
        >
          <TextField fullWidth
            isRequired
            name="email"
            type="email"
            value={email}
            onChange={setEmail}
            isDisabled={pending}
          >
            <Label>{t("email")}</Label>
            <Input autoComplete="email" />
          </TextField>
          {error ? (
            <Alert status="danger">
              <Alert.Content>
                <Alert.Description>{t("failed", { code: error })}</Alert.Description>
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
                {t("submit")}
              </>
            )}
          </Button>
        </Form>
      )}
    </AccountShell>
  );
}
