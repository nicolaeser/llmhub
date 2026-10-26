"use client";

import type { ReactNode } from "react";
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
import { NEW_MODEL_MODES } from "@/schemas/providers";
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

function FieldSection({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-4" aria-label={title}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

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
  const method = signInKind ? "signIn" : vertexKind ? "vertex" : "apiKey";

  function set(patch: Partial<ProviderDraft>) {
    onChange((current) => ({ ...current, ...patch }));
  }

  const credentials = vertexKind ? (
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
  );

  const region = (
    <Select
      selectedKey={draft.region || "none"}
      onSelectionChange={(key) => set({ region: String(key) === "none" ? "" : String(key) })}
      isDisabled={isDisabled}
      fullWidth
    >
      <Label>{t("dataHandling.region")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("dataHandling.region")}>
          {["none", ...DATA_REGIONS].map((option) => (
            <ListBox.Item key={option} id={option} textValue={t("dataHandling.regionOption", { region: option })}>
              {t("dataHandling.regionOption", { region: option })}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );

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
      ) : (
        <FieldSection title={t("form.connection")} hint={t("form.connectionHint", { method })}>
          {credentials}
        </FieldSection>
      )}
      <Separator />
      <FieldSection title={t("dataHandling.title")} hint={t("dataHandling.hint")}>
        <Switch isSelected={draft.zdr} onChange={(zdr) => set({ zdr })} isDisabled={isDisabled}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("dataHandling.zdr")}</Label>
          </Switch.Content>
          <Description>{t("dataHandling.zdrHint")}</Description>
        </Switch>
        {draft.zdr ? (
          region
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
              <TextField
                fullWidth
                value={draft.retention}
                onChange={(retention) => set({ retention })}
                isDisabled={isDisabled}
                isInvalid={!retentionValid(draft)}
              >
                <Label>{t("dataHandling.retention")}</Label>
                <Input inputMode="numeric" placeholder="30" />
                <Description>{t("dataHandling.retentionHint")}</Description>
              </TextField>
              {region}
            </div>
            <Switch
              isSelected={draft.noTraining}
              onChange={(noTraining) => set({ noTraining })}
              isDisabled={isDisabled}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{t("dataHandling.noTraining")}</Label>
              </Switch.Content>
              <Description>{t("dataHandling.noTrainingHint")}</Description>
            </Switch>
          </>
        )}
      </FieldSection>
      <Separator />
      <FieldSection title={t("form.models")} hint={t("form.modelsHint", { method })}>
        <Select
          fullWidth
          selectedKey={draft.newModels}
          onSelectionChange={(key) => {
            const newModels = NEW_MODEL_MODES.find((mode) => mode === key);
            if (newModels) set({ newModels });
          }}
          isDisabled={isDisabled}
        >
          <Label>{t("newModels")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("newModels")}>
              {NEW_MODEL_MODES.map((mode) => (
                <ListBox.Item key={mode} id={mode} textValue={t("newModelsOption", { mode })}>
                  {t("newModelsOption", { mode })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{t("newModelsHint", { mode: draft.newModels })}</Description>
        </Select>
        {signInKind ? null : (
          <Switch isSelected={draft.internal} onChange={(internal) => set({ internal })} isDisabled={isDisabled}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{t("internalOnly")}</Label>
            </Switch.Content>
            <Description>{t("internalOnlyHint")}</Description>
          </Switch>
        )}
      </FieldSection>
      <Separator />
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-left">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold text-foreground">{tCommon("advanced")}</span>
              <span className="text-sm text-muted">{t("form.advancedHint", { method })}</span>
            </span>
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="space-y-4 pt-4">
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
