"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Alert, Button, Chip, Description, Input, Label, Spinner, Surface, TextField } from "@heroui/react";
import { ExternalLink, FileJson } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { isActionFail } from "@/lib/http/action-result";
import { MAX_AUTH_FILE_BYTES } from "@/schemas/providers";
import type { ProviderSignIn, SignInFinish, SignInFlowActions, SignInKind, SignInStart } from "@/types/providers";
import { PlanBadge } from "@/components/console/subscription-badge";
import { useErrorToast } from "@/components/console/use-error-toast";

type Waiting = SignInStart & { delay: number };

export default function SignInPanel<T extends SignInFinish>({
  kind,
  current,
  isDisabled,
  actions,
  hint,
  onSignedIn,
}: {
  kind: SignInKind;
  current: ProviderSignIn | null;
  isDisabled: boolean;
  actions: SignInFlowActions<T>;
  hint?: string;
  onSignedIn: (result: T) => void;
}) {
  const t = useTranslations("Providers");
  const showError = useErrorToast();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [fresh, setFresh] = useState<ProviderSignIn | null>(null);
  const [pasted, setPasted] = useState("");
  const [pending, start] = useTransition();
  const [finishing, finish] = useTransition();
  const [importing, startImport] = useTransition();
  const picker = useRef<HTMLInputElement>(null);
  const flow = useRef(actions);
  const done = useRef(onSignedIn);
  const shown = fresh ?? current;
  const importFileAction = actions.importFile;

  useEffect(() => {
    flow.current = actions;
    done.current = onSignedIn;
  });

  useEffect(() => {
    if (!waiting || waiting.method === "code") return;
    let active = true;
    const timer = setTimeout(async () => {
      const result = await flow.current.poll({ ticket: waiting.ticket, interval: waiting.delay });
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
      done.current(result);
    }, waiting.delay * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [waiting, showError]);

  function begin() {
    start(async () => {
      const result = await actions.start(kind);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setPasted("");
      setWaiting({ ...result, delay: result.interval });
    });
  }

  function importFile(file: File) {
    if (!importFileAction) return;
    if (file.size > MAX_AUTH_FILE_BYTES) {
      showError("AUTH_FILE_TOO_LARGE");
      return;
    }
    startImport(async () => {
      const result = await importFileAction(kind, await file.text().catch(() => ""));
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setFresh({ account: result.account, plan: result.plan, status: "active" });
      onSignedIn(result);
    });
  }

  function complete(ticket: string) {
    finish(async () => {
      const result = await actions.complete({ ticket, code: pasted });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      if (result.state !== "done") return;
      setWaiting(null);
      setFresh({ account: result.account, plan: result.plan, status: "active" });
      onSignedIn(result);
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("signIn.title", { kind })}</p>
        <p className="text-sm text-muted">{hint ?? t("signIn.hint", { kind })}</p>
      </div>
      {shown ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 break-all text-foreground">
            {t("signIn.account", { named: shown.account ? "true" : "false", account: shown.account })}
          </span>
          <PlanBadge plan={shown.plan} />
          <Chip
            size="sm"
            variant="soft"
            color={shown.status === "active" ? "success" : "warning"}
            className="whitespace-nowrap"
          >
            {t("signIn.status", { status: shown.status })}
          </Chip>
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
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={shown?.status === "active" ? "secondary" : undefined}
              aria-label={t("signIn.start", { kind, again: shown ? "true" : "false" })}
              isPending={pending}
              isDisabled={isDisabled || importing}
              onPress={begin}
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("signIn.start", { kind, again: shown ? "true" : "false" })}
                </>
              )}
            </Button>
            {importFileAction ? (
              <>
                <input
                  ref={picker}
                  type="file"
                  accept=".json,application/json"
                  tabIndex={-1}
                  aria-hidden
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) importFile(file);
                  }}
                />
                <Button
                  variant="secondary"
                  aria-label={t("signIn.importFile")}
                  isPending={importing}
                  isDisabled={isDisabled || pending}
                  onPress={() => picker.current?.click()}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : <FileJson size={16} aria-hidden />}
                      {t("signIn.importFile")}
                    </>
                  )}
                </Button>
              </>
            ) : null}
          </div>
          {importFileAction ? <Description className="block">{t("signIn.importHint")}</Description> : null}
        </div>
      )}
    </div>
  );
}
