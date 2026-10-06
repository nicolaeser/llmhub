"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  Description,
  FieldError,
  Form,
  Input,
  Label,
  Spinner,
  TextField,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import BrandMark from "@/components/brand/brand-mark";
import { createFirstAdminAction } from "./_action";

export default function SetupPage() {
  const router = useRouter();
  const t = useTranslations("Setup");
  const tCommon = useTranslations("Common");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <main className="mx-auto w-full max-w-sm space-y-5 px-4 py-16">
      <div className="flex items-center gap-2.5">
        <BrandMark />
        <span className="text-sm font-semibold tracking-tight">{tCommon("appName")}</span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted">{t("subtitle")}</p>
      <Card>
        <Form
          validationBehavior="native"
          className="flex flex-col gap-4"
          aria-label={t("submit")}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError(null);
            startTransition(async () => {
              const result = await createFirstAdminAction({
                username: String(form.get("username") ?? ""),
                email: String(form.get("email") ?? ""),
                password: String(form.get("password") ?? ""),
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              router.replace("/");
            });
          }}
        >
          <TextField isRequired fullWidth name="username" isDisabled={pending}>
            <Label>{t("username")}</Label>
            <Input autoComplete="username" />
            <FieldError />
          </TextField>
          <TextField isRequired fullWidth name="email" type="email" isDisabled={pending}>
            <Label>{t("email")}</Label>
            <Input autoComplete="email" />
            <FieldError />
          </TextField>
          <TextField
            isRequired
            fullWidth
            name="password"
            type="password"
            minLength={10}
            isDisabled={pending}
          >
            <Label>{t("password")}</Label>
            <Input autoComplete="new-password" />
            <Description>{t("passwordRules")}</Description>
            <FieldError />
          </TextField>
          {error ? (
            <Alert status="danger">
              <Alert.Content>
                <Alert.Description>{t("errors.code", { code: error })}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
          <Button type="submit" fullWidth isPending={pending}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : null}
                {t("submit")}
              </>
            )}
          </Button>
        </Form>
      </Card>
      <p className="text-xs text-muted">{t("nextStep")}</p>
    </main>
  );
}
