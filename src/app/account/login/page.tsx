"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Skeleton, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/routing";
import AccountShell from "@/app/account/_components/account-shell";
import FormSkeleton from "@/app/account/_components/form-skeleton";
import { postLoginDestination, withReturnQuery } from "@/lib/auth/return-path";
import { isActionFail } from "@/lib/http/action-result";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import type { SsoAccessHelp } from "@/types/auth";
import type { LoginContext, LoginFlowStep, LoginResult } from "@/types/security";
import PasswordStep from "./_components/password-step";
import SecondFactorStep from "./_components/second-factor-step";
import EnrollmentStep from "./_components/enrollment-step";
import PasswordChangeStep from "./_components/password-change-step";
import { loginContextAction, ssoAccessHelpAction } from "./_action";

export default function LoginPage() {
  const t = useTranslations("Auth.login");
  const router = useRouter();
  const [context, setContext] = useState<Omit<LoginContext, "step"> | null>(null);
  const [step, setStep] = useState<LoginFlowStep>({ step: null });
  const returnParam = useSearchParam("return") ?? null;
  const ssoStatus = useSearchParam("sso");

  const announced = useRef<string | null>(null);

  const noRole = ssoStatus === "no_role";
  const [access, setAccess] = useState<SsoAccessHelp | null>(null);

  useEffect(() => {
    if (!noRole) return;
    ssoAccessHelpAction().then((result) => {
      setAccess(isActionFail(result) ? { provider: "", requestAccessUrl: "" } : result);
    });
  }, [noRole]);

  useEffect(() => {
    if (!ssoStatus || noRole || !context || announced.current === ssoStatus) return;
    announced.current = ssoStatus;
    toast.danger(t("toasts.ssoStatus", { status: ssoStatus, provider: context.ssoProvider || t("toasts.yourProvider") }));
  }, [ssoStatus, noRole, context, t]);

  useEffect(() => {
    loginContextAction().then((result) => {
      if (isActionFail(result)) {
        setContext({
          ssoEnabled: false,
          ssoProvider: "",
          ssoOnly: false,
          passkeysEnabled: false,
          registrationEnabled: false,
          passwordResetEnabled: false,
        });
        return;
      }
      setStep(result.step);
      setContext({
        ssoEnabled: result.ssoEnabled,
        ssoProvider: result.ssoProvider,
        ssoOnly: result.ssoOnly,
        passkeysEnabled: result.passkeysEnabled,
        registrationEnabled: result.registrationEnabled,
        passwordResetEnabled: result.passwordResetEnabled,
      });
    });
  }, []);

  function advance(result: LoginResult) {
    setStep(result);
    if (result.step !== "done") return;
    toast(t("toasts.welcomeBack"), { variant: "success" });
    if (result.recoveryCodesRemaining !== null) {
      toast.warning(t("toasts.recoveryRemaining", { count: result.recoveryCodesRemaining }));
    }
    router.replace(postLoginDestination(returnParam, "/"));
  }

  function restart(expired: boolean) {
    if (expired) toast.danger(t("toasts.expired"));
    setStep({ step: null });
  }

  const current = step.step === null ? "signin" : step.step === "password" ? "change" : step.step;

  return (
    <AccountShell
      title={t.rich("stepHeading", {
        step: current,
        lead: (chunks) => chunks,
        accent: (chunks) => <span className="text-accent">{chunks}</span>,
      })}
      subtitle={t("stepSubtitle", { step: current })}
      footer={
        context?.registrationEnabled && step.step === null
          ? t.rich("createPrompt", {
              create: (chunks) => (
                <Link
                  href={withReturnQuery("/account/register", returnParam)}
                  className="font-medium text-accent hover:text-accent/80"
                >
                  {chunks}
                </Link>
              ),
            })
          : undefined
      }
    >
      {noRole && step.step === null ? (
        <Alert status="warning" className="mb-6">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("noAccess.title")}</Alert.Title>
            <Alert.Description className="break-words">
              {t("noAccess.body", { provider: access?.provider || t("toasts.yourProvider") })}
            </Alert.Description>
            {access?.requestAccessUrl ? (
              <a href={access.requestAccessUrl} rel="noreferrer" className="mt-1 text-sm font-medium text-accent">
                {t("noAccess.request", { provider: access.provider || t("toasts.yourProvider") })}
              </a>
            ) : null}
          </Alert.Content>
        </Alert>
      ) : null}
      {!context ? (
        <FormSkeleton fields={2} />
      ) : step.step === null ? (
        <PasswordStep
          ssoEnabled={context.ssoEnabled}
          ssoOnly={context.ssoOnly}
          passkeysEnabled={context.passkeysEnabled}
          passwordResetEnabled={context.passwordResetEnabled}
          returnParam={returnParam}
          onResult={advance}
        />
      ) : step.step === "verify" ? (
        <SecondFactorStep methods={step.methods} onResult={advance} onRestart={restart} />
      ) : step.step === "enroll" ? (
        <EnrollmentStep onResult={advance} onRestart={restart} />
      ) : step.step === "password" ? (
        <PasswordChangeStep onResult={advance} onRestart={restart} />
      ) : (
        <div aria-busy className="space-y-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <p className="text-center text-sm text-muted">{t("redirecting")}</p>
        </div>
      )}
    </AccountShell>
  );
}
