"use client";

import { useState, useTransition } from "react";
import { Button, Form, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/routing";
import { withReturnQuery } from "@/lib/auth/return-path";
import { isActionFail } from "@/lib/http/action-result";
import { useSecurityError } from "@/components/security/use-security-error";
import {
  PasskeyCancelledError,
  passkeyAssertion,
  usePasskeySupport,
} from "@/components/security/webauthn";
import type { LoginResult } from "@/types/security";
import {
  passwordSignInAction,
  passwordlessOptionsAction,
  verifyPasswordlessAction,
} from "../_action";

export default function PasswordStep({
  ssoEnabled,
  passkeysEnabled,
  passwordResetEnabled,
  returnParam,
  onResult,
}: {
  ssoEnabled: boolean;
  passkeysEnabled: boolean;
  passwordResetEnabled: boolean;
  returnParam: string | null;
  onResult: (result: LoginResult) => void;
}) {
  const t = useTranslations("Auth.login");
  const router = useRouter();
  const errorText = useSecurityError();
  const browserPasskeys = usePasskeySupport();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const [passkeyPending, startPasskey] = useTransition();
  const busy = pending || passkeyPending;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start(async () => {
      const result = await passwordSignInAction({ email, password });
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      setPassword("");
      onResult(result);
    });
  }

  function signInWithPasskey() {
    startPasskey(async () => {
      const options = await passwordlessOptionsAction();
      if (isActionFail(options)) {
        toast.danger(errorText(options.error));
        return;
      }
      try {
        const response = await passkeyAssertion(options);
        const result = await verifyPasswordlessAction({ response });
        if (isActionFail(result)) {
          toast.danger(errorText(result.error));
          return;
        }
        onResult(result);
      } catch (error) {
        if (error instanceof PasskeyCancelledError) return;
        toast.danger(errorText("PASSKEY_VERIFICATION_FAILED"));
      }
    });
  }

  return (
    <>
      <Form
        validationBehavior="native"
        onSubmit={handleSubmit}
        className="space-y-5"
        aria-label={t("signIn")}
      >
        <TextField fullWidth isRequired name="email" type="email" value={email} onChange={setEmail}>
          <Label>{t("email")}</Label>
          <Input
            autoComplete="username webauthn"
            placeholder={t("emailPlaceholder")}
          />
        </TextField>
        <div className="space-y-1">
          <TextField fullWidth
            isRequired
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
          >
            <Label>{t("password")}</Label>
            <Input
              autoComplete="current-password"
              placeholder={t("passwordPlaceholder")}
            />
          </TextField>
          {passwordResetEnabled ? (
            <div className="flex justify-end">
              <Link
                href={withReturnQuery("/account/forgot-password", returnParam)}
                className="mt-1 text-xs text-muted hover:text-accent"
              >
                {t("forgotPassword")}
              </Link>
            </div>
          ) : null}
        </div>
        <Button
          type="submit"
          fullWidth
          size="lg"
          isPending={pending}
          isDisabled={busy}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("signIn")}
            </>
          )}
        </Button>
      </Form>
      {(passkeysEnabled && browserPasskeys) || ssoEnabled ? (
        <div className="mt-5 space-y-3">
          <p className="text-center text-xs uppercase tracking-widest text-muted">
            {t("or")}
          </p>
          {passkeysEnabled && browserPasskeys ? (
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
                  {isPending ? (
                    <Spinner color="current" size="sm" />
                  ) : (
                    <KeyRound size={16} aria-hidden />
                  )}
                  {t("passkey")}
                </>
              )}
            </Button>
          ) : null}
          {ssoEnabled ? (
            <Button
              variant="secondary"
              fullWidth
              size="lg"
              isDisabled={busy}
              onPress={() => {
                router.replace(withReturnQuery("/sso/login", returnParam));
              }}
            >
              {t("sso")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
