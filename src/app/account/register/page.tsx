"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Alert,
  Button,
  FieldError,
  Form,
  Input,
  Label,
  Skeleton,
  Spinner,
  TextField,
  toast,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/routing";
import AccountShell from "@/app/account/_components/account-shell";
import { isActionFail } from "@/lib/http/action-result";
import { registrationContextAction } from "./_action";

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("Auth.register");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    registrationContextAction().then((result) => {
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
      footer={t.rich("signInPrompt", {
        signin: (chunks) => (
          <Link href="/account/login" className="font-medium text-accent">
            {chunks}
          </Link>
        ),
      })}
    >
      {enabled === null ? (
        <div aria-busy className="space-y-5">
          <Skeleton className="h-16 w-full rounded-xl" />
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
      ) : (
        <Form
          validationBehavior="native"
          className="space-y-5"
          aria-label={t("submit")}
          onSubmit={(event) => {
            event.preventDefault();
            start(async () => {
              const response = await fetch("/internal-api/account/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, email, password }),
              }).catch(() => null);
              const data = (await response?.json().catch(() => null)) as {
                redirect?: string;
                code?: string;
              } | null;
              if (!response?.ok) {
                toast.danger(t("toasts.failed", { code: data?.code ?? "other" }));
                return;
              }
              toast(t("toasts.created"), { variant: "success" });
              router.replace(data?.redirect || "/account/login");
            });
          }}
        >
          <TextField fullWidth isRequired name="username" value={username} onChange={setUsername} isDisabled={pending}>
            <Label>{t("username")}</Label>
            <Input autoComplete="username" />
          </TextField>
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
          <TextField fullWidth
            isRequired
            name="password"
            type="password"
            minLength={10}
            value={password}
            onChange={setPassword}
            isDisabled={pending}
          >
            <Label>{t("password")}</Label>
            <Input autoComplete="new-password" />
            <FieldError />
          </TextField>
          <p className="text-xs text-muted">{t("rules")}</p>
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
