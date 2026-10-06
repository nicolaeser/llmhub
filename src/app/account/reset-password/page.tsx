"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Description,
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
import { useSecurityError } from "@/components/security/use-security-error";
import { useSearchParam } from "@/lib/hooks/use-search-param";

export default function ResetPasswordPage() {
  const router = useRouter();
  const t = useTranslations("Auth.reset");
  const errorText = useSecurityError();
  const token = useSearchParam("token");
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();

  return (
    <AccountShell
      title={t.rich("heading", {
        lead: (chunks) => chunks,
        accent: (chunks) => <span className="text-muted">{chunks}</span>,
      })}
      footer={
        <Link href="/account/login" className="text-accent">
          {t("back")}
        </Link>
      }
    >
      {token === undefined ? (
        <div aria-busy className="space-y-5">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : !token ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{t("invalid")}</Alert.Description>
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
              const response = await fetch("/internal-api/account/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, password }),
              }).catch(() => null);
              if (!response?.ok) {
                const body = response
                  ? ((await response.json().catch(() => ({}))) as { code?: string })
                  : {};
                const code = body.code ?? "REQUEST_FAILED";
                toast.danger(code === "INVALID_TOKEN" ? t("invalid") : errorText(code));
                return;
              }
              toast(t("success"), { variant: "success" });
              router.replace("/account/login");
            });
          }}
        >
          <TextField
            fullWidth
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
            <Description>{t("rules")}</Description>
            <FieldError />
          </TextField>
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
