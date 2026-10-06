"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Separator,
  Spinner,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { DATA_REGIONS } from "@/lib/gateway/model-policy";
import { isActionFail } from "@/lib/http/action-result";
import { createProviderAction, updateProviderAction } from "@/app/(app)/providers/_action";
import type { ProviderView } from "@/types/providers";

export default function ProviderDialog({
  state,
  spec,
  editing,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  spec: (typeof PROVIDER_CATALOG)[number] | null;
  editing: ProviderView | null;
  onSaved: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [name, setName] = useState(
    editing?.name ?? (spec ? t("kindName", { kind: spec.kind }) : ""),
  );
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? spec?.default_base_url ?? "");
  const [apiKey, setApiKey] = useState("");
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
      const body = { name, kind: spec.kind, baseUrl, apiKey, policy };
      const result = editing
        ? await updateProviderAction({ id: editing.id, ...body })
        : await createProviderAction(body);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.provider);
      toast(t("toasts.saved", { mode: editing ? "updated" : "created" }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>
                    {t("formTitle", {
                      mode: editing ? "edit" : "connect",
                      name: spec ? t("kindName", { kind: spec.kind }) : (editing?.name ?? ""),
                    })}
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  <TextField fullWidth value={apiKey} onChange={setApiKey} isDisabled={pending} aria-label={t("apiKey")}>
                    <Label>{t("apiKey")}</Label>
                    <Input
                      type="password"
                      aria-label={t("apiKey")}
                      placeholder={editing?.hasApiKey ? t("apiKeyKeep") : "sk-…"}
                    />
                  </TextField>
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
                        <TextField fullWidth value={baseUrl} onChange={setBaseUrl} isDisabled={pending} aria-label={t("baseUrl")}>
                          <Label>{t("baseUrl")}</Label>
                          <Input aria-label={t("baseUrl")} />
                        </TextField>
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending} aria-label={tCommon("cancel")}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    aria-label={t("formSubmit", { mode: editing ? "save" : "connect" })}
                    isPending={pending}
                    isDisabled={!spec || !retentionValid}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("formSubmit", { mode: editing ? "save" : "connect" })}
                      </>
                    )}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
