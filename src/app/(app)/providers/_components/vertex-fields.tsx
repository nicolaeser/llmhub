"use client";

import { useRef } from "react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { FileJson } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { MAX_VERTEX_CREDENTIAL_CHARS, serviceAccountSummary } from "@/lib/gateway/upstreams/vertex-target";
import { formatBytes } from "@/lib/utils/bytes";
import type { VertexCredentialKind, VertexDraft, VertexView } from "@/types/providers";

const CREDENTIALS: readonly VertexCredentialKind[] = ["service_account", "api_key"];

export default function VertexFields({
  draft,
  current,
  apiKey,
  isDisabled,
  onApiKey,
  onChange,
}: {
  draft: VertexDraft;
  current: VertexView | null;
  apiKey: string;
  isDisabled: boolean;
  onApiKey: (value: string) => void;
  onChange: (draft: VertexDraft) => void;
}) {
  const t = useTranslations("Providers.vertex");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const picker = useRef<HTMLInputElement>(null);
  const maxSize = formatBytes(format, MAX_VERTEX_CREDENTIAL_CHARS);
  const text = draft.serviceAccount.trim();
  const tooLarge = text.length > MAX_VERTEX_CREDENTIAL_CHARS;
  const invalid = Boolean(text) && !tooLarge && serviceAccountSummary(text) === null;
  const keepsStored = current !== null && current.credential === draft.credential;

  function setServiceAccount(value: string) {
    const next = serviceAccountSummary(value);
    const previous = serviceAccountSummary(draft.serviceAccount);
    const project = draft.project.trim();
    const automatic = !project || project === previous?.project || project === current?.project;
    onChange({ ...draft, serviceAccount: value, project: next?.project && automatic ? next.project : draft.project });
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_VERTEX_CREDENTIAL_CHARS) {
      toast.danger(t("serviceAccountTooLarge", { size: maxSize }));
      return;
    }
    setServiceAccount(await file.text().catch(() => ""));
  }

  return (
    <div className="space-y-4">
      {current ? (
        <p className="break-words text-sm text-muted">
          {t("current", {
            credential: current.credential,
            named: current.account ? "true" : "false",
            account: current.account,
            project: current.project,
            location: current.location,
          })}
        </p>
      ) : null}
      <RadioGroup
        value={draft.credential}
        onChange={(value) => {
          const credential = CREDENTIALS.find((item) => item === value);
          if (credential) onChange({ ...draft, credential });
        }}
        orientation="horizontal"
        isDisabled={isDisabled}
        className="gap-2"
      >
        <Label>{t("credentialLabel")}</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {CREDENTIALS.map((credential) => (
            <Radio key={credential} value={credential}>
              <Radio.Content className="items-center gap-2">
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                <Label>{t("credential", { kind: credential })}</Label>
              </Radio.Content>
            </Radio>
          ))}
        </div>
      </RadioGroup>
      {draft.credential === "service_account" ? (
        <>
          <TextField
            fullWidth
            value={draft.serviceAccount}
            onChange={setServiceAccount}
            isDisabled={isDisabled}
            isInvalid={invalid || tooLarge}
          >
            <Label>{t("serviceAccountLabel")}</Label>
            <TextArea
              rows={6}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder={keepsStored ? t("serviceAccountKeep") : t("serviceAccountPlaceholder")}
            />
            <Description>{t("serviceAccountHint")}</Description>
            <FieldError>{tooLarge ? t("serviceAccountTooLarge", { size: maxSize }) : t("serviceAccountInvalid")}</FieldError>
          </TextField>
          <div className="flex flex-wrap gap-2">
            <input
              ref={picker}
              type="file"
              accept=".json,application/json"
              tabIndex={-1}
              aria-hidden
              className="sr-only"
              onChange={(event) => {
                void readFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <Button size="sm" variant="secondary" isDisabled={isDisabled} onPress={() => picker.current?.click()}>
              <FileJson size={14} aria-hidden />
              {t("upload")}
            </Button>
            {draft.serviceAccount ? (
              <Button size="sm" variant="ghost" isDisabled={isDisabled} onPress={() => setServiceAccount("")}>
                {t("clear")}
              </Button>
            ) : null}
          </div>
          <TextField
            fullWidth
            value={draft.project}
            onChange={(project) => onChange({ ...draft, project })}
            isDisabled={isDisabled}
          >
            <Label>{t("project")}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder="my-project-123" />
            <Description>{t("projectHint")}</Description>
          </TextField>
          <TextField
            fullWidth
            value={draft.location}
            onChange={(location) => onChange({ ...draft, location })}
            isDisabled={isDisabled}
          >
            <Label>{t("location")}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder="global" />
            <Description>{t("locationHint")}</Description>
          </TextField>
        </>
      ) : (
        <TextField fullWidth value={apiKey} onChange={onApiKey} isDisabled={isDisabled}>
          <Label>{tProviders("apiKey")}</Label>
          <Input type="password" autoComplete="off" placeholder={keepsStored ? tProviders("apiKeyKeep") : "AIza…"} />
          <Description>{t("apiKeyHint")}</Description>
        </TextField>
      )}
    </div>
  );
}
