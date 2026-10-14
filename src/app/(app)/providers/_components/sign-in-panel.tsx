"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Badge, Button, Input, Label, Spinner, Surface, TextField } from "@heroui/react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { completeSignInAction, pollSignInAction, startSignInAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderSignIn, SignInKind, SignInStart } from "@/types/providers";
import { PlanBadge } from "@/components/console/subscription-badge";
import { useErrorToast } from "@/components/console/use-error-toast";

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
  const showError = useErrorToast();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [fresh, setFresh] = useState<ProviderSignIn | null>(null);
  const [pasted, setPasted] = useState("");
  const [pending, start] = useTransition();
  const [finishing, finish] = useTransition();
  const shown = fresh ?? current;

  useEffect(() => {
    if (!waiting || waiting.method === "code") return;
    let active = true;
    const timer = setTimeout(async () => {
      const result = await pollSignInAction({ ticket: waiting.ticket, interval: waiting.delay });
      if (!active) return;
      if (isActionFail(result)) {
        setWaiting(null);
        showError(result.error);
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
  }, [waiting, onSignedIn, showError]);

  function begin() {
    start(async () => {
      const result = await startSignInAction(kind);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setPasted("");
      setWaiting({ ...result, delay: result.interval });
    });
  }

  function complete(ticket: string) {
    finish(async () => {
      const result = await completeSignInAction({ ticket, code: pasted });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      if (result.state !== "done") return;
      setWaiting(null);
      setFresh({ account: result.account, plan: result.plan, status: "active" });
      onSignedIn(result.credential);
    });
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
          <PlanBadge plan={shown.plan} />
          <Badge
            size="sm"
            variant="soft"
            color={shown.status === "active" ? "success" : "warning"}
            className="px-1.5 whitespace-nowrap"
          >
            {t("signIn.status", { status: shown.status })}
          </Badge>
        </div>
      ) : null}
      {waiting?.method === "code" ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content className="min-w-0 space-y-3">
            <Alert.Title>{t("signIn.pasteTitle")}</Alert.Title>
            <Alert.Description>{t("signIn.pasteHint", { kind })}</Alert.Description>
            <a
              href={waiting.verificationUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm font-medium text-accent"
            >
              <ExternalLink size={14} aria-hidden />
              {t("signIn.open", { kind })}
            </a>
            <TextField fullWidth value={pasted} onChange={setPasted} isDisabled={finishing} aria-label={t("signIn.pasteLabel")}>
              <Label>{t("signIn.pasteLabel")}</Label>
              <Input
                aria-label={t("signIn.pasteLabel")}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (pasted.trim() && !finishing) complete(waiting.ticket);
                }}
              />
            </TextField>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                aria-label={t("signIn.finish")}
                isPending={finishing}
                isDisabled={!pasted.trim()}
                onPress={() => complete(waiting.ticket)}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {t("signIn.finish")}
                  </>
                )}
              </Button>
              <Button size="sm" variant="tertiary" aria-label={t("signIn.cancel")} onPress={() => setWaiting(null)}>
                {t("signIn.cancel")}
              </Button>
            </div>
          </Alert.Content>
        </Alert>
      ) : waiting ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content className="min-w-0 space-y-2">
            <Alert.Title>{t("signIn.codeTitle")}</Alert.Title>
            <Alert.Description>{t("signIn.codeHint", { kind })}</Alert.Description>
            <div className="flex min-w-0 items-center gap-2">
              <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                <code className="font-mono text-lg break-all">{waiting.userCode}</code>
              </Surface>
              <CopyButton text={waiting.userCode} label={t("signIn.copy")} variant="secondary" />
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
