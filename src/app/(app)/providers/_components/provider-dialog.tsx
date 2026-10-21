"use client";

import { useState, useTransition } from "react";
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
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { DATA_REGIONS } from "@/lib/gateway/access/model-policy";
import { isActionFail } from "@/lib/http/action-result";
import {
  completeSignInAction,
  createProviderAction,
  importSignInFileAction,
  pollSignInAction,
  startSignInAction,
  updateProviderAction,
} from "../_action";
import { VERTEX_DEFAULT_LOCATION } from "@/lib/gateway/upstreams/vertex-target";
import type { ProviderView, SignInFileResult, SignInFlowActions, VertexDraft } from "@/types/providers";
import SignInPanel from "@/components/providers/sign-in-panel";
import { useErrorToast } from "@/components/console/use-error-toast";
import FormDialog from "@/components/console/form-dialog";
import VertexFields, { vertexDraftReady } from "./vertex-fields";

const SIGN_IN_ACTIONS: SignInFlowActions<SignInFileResult> = {
  start: startSignInAction,
  poll: pollSignInAction,
  complete: completeSignInAction,
  importFile: importSignInFileAction,
};

export default function ProviderDialog({
  state,
  spec,
  editing,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  spec: (typeof PROVIDER_CATALOG)[number] | null;
  editing: ProviderView | null;
  onSaved: (provider: ProviderView, superseded: string[]) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [name, setName] = useState(
    editing?.name ?? (spec ? t("kindName", { kind: spec.kind }) : ""),
  );
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? spec?.default_base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [signIn, setSignIn] = useState("");
  const signInKind = spec && isSignInKind(spec.kind) ? spec.kind : null;
  const vertexKind = spec?.kind === "vertex";
  const currentVertex = editing?.vertex ?? null;
  const [vertex, setVertex] = useState<VertexDraft>({
    credential: currentVertex?.credential ?? "service_account",
    serviceAccount: "",
    project: currentVertex?.project ?? "",
    location: currentVertex?.location || VERTEX_DEFAULT_LOCATION,
  });
  const [zdr, setZdr] = useState(editing?.policy.zdr ?? false);
  const [retention, setRetention] = useState(
    !editing || editing.policy.zdr || editing.policy.retentionDays === null
      ? ""
      : String(editing.policy.retentionDays),
  );
  const [region, setRegion] = useState(
    editing?.policy.region ?? (spec?.kind === "openrouter_eu" ? "eu" : ""),
  );
  const [noTraining, setNoTraining] = useState(editing?.policy.noTraining ?? false);
  const [pending, start] = useTransition();
  const retentionValid = zdr || /^\d{0,4}$/.test(retention.trim());

  function save(close: () => void) {
    if (!spec) return;
    start(async () => {
      const policy = {
        zdr,
        retentionDays: zdr ? 0 : retention.trim() ? Number(retention.trim()) : null,
        region,
        noTraining: zdr || noTraining,
      };
      const credential = vertexKind && vertex.credential === "service_account" ? vertex.serviceAccount : apiKey;
      const target = vertexKind && vertex.credential === "service_account" ? { project: vertex.project, location: vertex.location } : undefined;
      const body = {
        name,
        kind: spec.kind,
        baseUrl: vertexKind ? "" : baseUrl,
        apiKey: credential,
        signIn: signIn || undefined,
        policy,
        vertex: target,
      };
      const result = editing
        ? await updateProviderAction({ id: editing.id, ...body })
        : await createProviderAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.provider, result.superseded);
      toast(t("toasts.saved", { mode: result.outcome }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="sm"
      title={t("formTitle", {
        mode: editing ? "edit" : "connect",
        name: spec ? t("kindName", { kind: spec.kind }) : (editing?.name ?? ""),
      })}
      submitLabel={t("formSubmit", { mode: editing ? "save" : "connect" })}
      pending={pending}
      isSubmitDisabled={
        !spec ||
        !retentionValid ||
        Boolean(signInKind && !editing && !signIn) ||
        (vertexKind && !vertexDraftReady(vertex, apiKey, currentVertex))
      }
      onSubmit={save}
    >
      {signInKind ? (
        <SignInPanel
          kind={signInKind}
          current={editing?.signIn ?? null}
          isDisabled={pending}
          actions={SIGN_IN_ACTIONS}
          onSignedIn={(result) => setSignIn(result.credential)}
        />
      ) : vertexKind ? (
        <VertexFields
          draft={vertex}
          current={currentVertex}
          apiKey={apiKey}
          isDisabled={pending}
          onApiKey={setApiKey}
          onChange={setVertex}
        />
      ) : (
        <TextField fullWidth value={apiKey} onChange={setApiKey} isDisabled={pending} aria-label={t("apiKey")}>
          <Label>{t("apiKey")}</Label>
          <Input
            type="password"
            aria-label={t("apiKey")}
            placeholder={editing?.hasApiKey ? t("apiKeyKeep") : spec?.kind === "gemini" ? "AIza…" : "sk-…"}
          />
        </TextField>
      )}
      <Separator />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("policy.title")}</p>
        <p className="text-sm text-muted">{t("policy.hint")}</p>
      </div>
      <Switch isSelected={zdr} onChange={setZdr} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("policy.zdr")}</Label>
        </Switch.Content>
        <Description>{t("policy.zdrHint")}</Description>
      </Switch>
      {zdr ? null : (
        <>
          <TextField
            fullWidth
            value={retention}
            onChange={setRetention}
            isDisabled={pending}
            isInvalid={!retentionValid}
          >
            <Label>{t("policy.retention")}</Label>
            <Input inputMode="numeric" placeholder="30" />
            <Description>{t("policy.retentionHint")}</Description>
          </TextField>
          <Switch isSelected={noTraining} onChange={setNoTraining} isDisabled={pending}>
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
        selectedKey={region || "none"}
        onSelectionChange={(key) => setRegion(String(key) === "none" ? "" : String(key))}
        isDisabled={pending}
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
              <ListBox.Item
                key={option}
                id={option}
                textValue={t("policy.regionOption", { region: option })}
              >
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
            <TextField fullWidth value={name} onChange={setName} isDisabled={pending} aria-label={t("displayName")}>
              <Label>{t("displayName")}</Label>
              <Input aria-label={t("displayName")} />
            </TextField>
            {signInKind || vertexKind ? null : (
              <TextField fullWidth value={baseUrl} onChange={setBaseUrl} isDisabled={pending} aria-label={t("baseUrl")}>
                <Label>{t("baseUrl")}</Label>
                <Input aria-label={t("baseUrl")} />
              </TextField>
            )}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </FormDialog>
  );
}
