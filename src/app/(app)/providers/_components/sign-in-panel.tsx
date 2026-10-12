"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Chip, Spinner, Surface, toast } from "@heroui/react";
import { Copy, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { pollSignInAction, startSignInAction } from "@/app/(app)/providers/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderSignIn, SignInKind, SignInStart } from "@/types/providers";

type Waiting = SignInStart & { delay: number };

export default function SignInPanel({
  kind,
  current,
  isDisabled,
  onSignedIn,
}: {
  kind: SignInKind;
  current: ProviderSignIn | null;
  isDisabled: boolean;
  onSignedIn: (credential: string) => void;
}) {
  const t = useTranslations("Providers");
  const tError = useTranslations("Error");
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [fresh, setFresh] = useState<ProviderSignIn | null>(null);
  const [pending, start] = useTransition();
  const shown = fresh ?? current;

  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const timer = setTimeout(async () => {
      const result = await pollSignInAction({ ticket: waiting.ticket, interval: waiting.delay });
      if (!active) return;
      if (isActionFail(result)) {
        setWaiting(null);
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      if (result.state === "pending") {
        setWaiting({ ...waiting, delay: result.interval });
        return;
      }
      setWaiting(null);
      setFresh({ account: result.account, plan: result.plan, status: "active" });
      onSignedIn(result.credential);
    }, waiting.delay * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [waiting, onSignedIn, tError]);

  function begin() {
    start(async () => {
      const result = await startSignInAction(kind);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setWaiting({ ...result, delay: result.interval });
    });
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast(t("signIn.copied"), { variant: "success" });
    } catch {
      toast.danger(t("signIn.copyFailed"));
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("signIn.title", { kind })}</p>
        <p className="text-sm text-muted">{t("signIn.hint", { kind })}</p>
      </div>
      {shown ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 break-all text-foreground">
            {t("signIn.account", { named: shown.account ? "true" : "false", account: shown.account })}
          </span>
          {shown.plan ? (
            <Chip size="sm" variant="soft">
              {t("signIn.plan", { plan: shown.plan })}
            </Chip>
          ) : null}
          <Chip size="sm" variant="soft" color={shown.status === "active" ? "success" : "warning"}>
            {t("signIn.status", { status: shown.status })}
          </Chip>
        </div>
      ) : null}
      {waiting ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content className="min-w-0 space-y-2">
            <Alert.Title>{t("signIn.codeTitle")}</Alert.Title>
            <Alert.Description>{t("signIn.codeHint", { kind })}</Alert.Description>
            <div className="flex min-w-0 items-center gap-2">
              <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                <code className="font-mono text-lg break-all">{waiting.userCode}</code>
              </Surface>
              <Button
                isIconOnly
                size="sm"
                variant="secondary"
                aria-label={t("signIn.copy")}
                onPress={() => copyCode(waiting.userCode)}
              >
                <Copy size={14} aria-hidden />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={waiting.verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-sm font-medium text-accent"
              >
                <ExternalLink size={14} aria-hidden />
                {t("signIn.open", { kind })}
              </a>
              <output aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
                <Spinner color="current" size="sm" />
                {t("signIn.waiting")}
              </output>
            </div>
            <Button size="sm" variant="tertiary" aria-label={t("signIn.cancel")} onPress={() => setWaiting(null)}>
              {t("signIn.cancel")}
            </Button>
          </Alert.Content>
        </Alert>
      ) : (
        <Button
          variant={shown?.status === "active" ? "secondary" : undefined}
          aria-label={t("signIn.start", { kind, again: shown ? "true" : "false" })}
          isPending={pending}
          isDisabled={isDisabled}
          onPress={begin}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("signIn.start", { kind, again: shown ? "true" : "false" })}
            </>
          )}
        </Button>
      )}
    </div>
  );
}
