"use client";

import {
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  Switch,
  TextField,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import SignInPanel from "@/components/providers/sign-in-panel";
import { DATA_REGIONS } from "@/lib/gateway/access/model-policy";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import type {
  ProviderDraft,
  ProviderKindSpec,
  ProviderView,
  SignInFileResult,
  SignInFlowActions,
} from "@/types/providers";
import { completeSignInAction, importSignInFileAction, pollSignInAction, startSignInAction } from "../_action";
import { retentionValid } from "./provider-draft";
import VertexFields from "./vertex-fields";

const SIGN_IN_ACTIONS: SignInFlowActions<SignInFileResult> = {
  start: startSignInAction,
  poll: pollSignInAction,
  complete: completeSignInAction,
  importFile: importSignInFileAction,
};

export default function ProviderFields({
  spec,
  editing,
  draft,
  isDisabled,
  onChange,
}: {
  spec: ProviderKindSpec;
  editing: ProviderView | null;
  draft: ProviderDraft;
  isDisabled: boolean;
  onChange: (update: (draft: ProviderDraft) => ProviderDraft) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const signInKind = isSignInKind(spec.kind) ? spec.kind : null;
  const vertexKind = spec.kind === "vertex";

  function set(patch: Partial<ProviderDraft>) {
    onChange((current) => ({ ...current, ...patch }));
  }

  return (
    <>
      {signInKind ? (
        <SignInPanel
          kind={signInKind}
          current={editing?.signIn ?? null}
          isDisabled={isDisabled}
          actions={SIGN_IN_ACTIONS}
          onSignedIn={(result) => set({ signIn: result.credential })}
        />
      ) : vertexKind ? (
        <VertexFields
          draft={draft.vertex}
          current={editing?.vertex ?? null}
          apiKey={draft.apiKey}
          isDisabled={isDisabled}
          onApiKey={(apiKey) => set({ apiKey })}
          onChange={(vertex) => set({ vertex })}
        />
      ) : (
        <TextField
          fullWidth
          value={draft.apiKey}
          onChange={(apiKey) => set({ apiKey })}
          isDisabled={isDisabled}
          aria-label={t("apiKey")}
        >
          <Label>{t("apiKey")}</Label>
          <Input
            type="password"
            aria-label={t("apiKey")}
            placeholder={editing?.hasApiKey ? t("apiKeyKeep") : spec.kind === "gemini" ? "AIza…" : "sk-…"}
          />
        </TextField>
      )}
      <Separator />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("policy.title")}</p>
        <p className="text-sm text-muted">{t("policy.hint")}</p>
      </div>
      <Switch isSelected={draft.zdr} onChange={(zdr) => set({ zdr })} isDisabled={isDisabled}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("policy.zdr")}</Label>
        </Switch.Content>
        <Description>{t("policy.zdrHint")}</Description>
      </Switch>
      {draft.zdr ? null : (
        <>
          <TextField
            fullWidth
            value={draft.retention}
            onChange={(retention) => set({ retention })}
            isDisabled={isDisabled}
            isInvalid={!retentionValid(draft)}
          >
            <Label>{t("policy.retention")}</Label>
            <Input inputMode="numeric" placeholder="30" />
            <Description>{t("policy.retentionHint")}</Description>
          </TextField>
          <Switch isSelected={draft.noTraining} onChange={(noTraining) => set({ noTraining })} isDisabled={isDisabled}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{t("policy.noTraining")}</Label>
            </Switch.Content>
            <Description>{t("policy.noTrainingHint")}</Description>
          </Switch>
        </>
      )}
      <Select
        selectedKey={draft.region || "none"}
        onSelectionChange={(key) => set({ region: String(key) === "none" ? "" : String(key) })}
        isDisabled={isDisabled}
        fullWidth
      >
        <Label>{t("policy.region")}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox aria-label={t("policy.region")}>
            {["none", ...DATA_REGIONS].map((option) => (
              <ListBox.Item key={option} id={option} textValue={t("policy.regionOption", { region: option })}>
                {t("policy.regionOption", { region: option })}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
            {tCommon("advanced")}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="space-y-4 pt-3">
            <TextField
              fullWidth
              value={draft.name}
              onChange={(name) => set({ name })}
              isDisabled={isDisabled}
              aria-label={t("displayName")}
            >
              <Label>{t("displayName")}</Label>
              <Input aria-label={t("displayName")} />
            </TextField>
            {signInKind || vertexKind ? null : (
              <TextField
                fullWidth
                value={draft.baseUrl}
                onChange={(baseUrl) => set({ baseUrl })}
                isDisabled={isDisabled}
                aria-label={t("baseUrl")}
              >
                <Label>{t("baseUrl")}</Label>
                <Input aria-label={t("baseUrl")} />
              </TextField>
            )}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </>
  );
}
