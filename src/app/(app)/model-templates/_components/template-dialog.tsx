"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Separator,
  Spinner,
  Switch,
  Tag,
  TagGroup,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import MultiPicker from "@/components/console/multi-picker";
import { createTemplateAction, updateTemplateAction } from "@/app/(app)/model-templates/_action";
import { isActionFail } from "@/lib/http/action-result";
import { DATA_REGIONS, hasRules, templateModels } from "@/lib/gateway/model-policy";
import type {
  ModelPolicy,
  ModelTemplateView,
  TemplateProviderOption,
  TemplateRules,
} from "@/types/model-templates";

const PRESETS = {
  blank: {},
  zdr: { zdrOnly: true },
  eu: { regions: ["eu"] },
  noTraining: { noTrainingOnly: true },
  shortRetention: { maxRetentionDays: 30 },
} satisfies Record<string, Partial<TemplateRules>>;

type Preset = keyof typeof PRESETS;

const PREVIEW_LIMIT = 40;

function splitPatterns(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseDays(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

export default function TemplateDialog({
  state,
  editing,
  policies,
  providers,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: ModelTemplateView | null;
  policies: ModelPolicy[];
  providers: TemplateProviderOption[];
  onSaved: (template: ModelTemplateView) => void;
}) {
  const t = useTranslations("ModelTemplates");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [preset, setPreset] = useState<Preset>("blank");
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [providerIds, setProviderIds] = useState<string[]>(editing?.providerIds ?? []);
  const [patterns, setPatterns] = useState((editing?.patterns ?? []).join(", "));
  const [regions, setRegions] = useState<string[]>(editing?.regions ?? []);
  const [retention, setRetention] = useState(
    editing?.maxRetentionDays === null || editing?.maxRetentionDays === undefined
      ? ""
      : String(editing.maxRetentionDays),
  );
  const [zdrOnly, setZdrOnly] = useState(editing?.zdrOnly ?? false);
  const [noTrainingOnly, setNoTrainingOnly] = useState(editing?.noTrainingOnly ?? false);
  const [models, setModels] = useState<string[]>(editing?.models ?? []);
  const [pending, start] = useTransition();

  const days = parseDays(retention);
  const rules: TemplateRules = {
    models,
    patterns: splitPatterns(patterns),
    providerIds,
    regions,
    zdrOnly,
    noTrainingOnly,
    maxRetentionDays: days ?? null,
  };
  const defined = models.length > 0 || hasRules(rules);
  const matches = defined ? templateModels(rules, policies) : [];
  const mode = editing ? "edit" : "create";

  function applyPreset(next: Preset) {
    const rule: Partial<TemplateRules> = PRESETS[next];
    setPreset(next);
    setRegions(rule.regions ?? []);
    setZdrOnly(rule.zdrOnly ?? false);
    setNoTrainingOnly(rule.noTrainingOnly ?? false);
    setRetention(rule.maxRetentionDays === undefined ? "" : String(rule.maxRetentionDays));
    if (!name.trim() || name === t("preset.name", { preset })) setName(t("preset.name", { preset: next }));
  }

  function save(close: () => void) {
    start(async () => {
      const body = { name, description, ...rules };
      const result = editing
        ? await updateTemplateAction({ ...body, id: editing.id })
        : await createTemplateAction(body);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.template);
      toast(t("toasts.saved", { mode }), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("dialogTitle", { mode })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  {editing ? null : (
                    <Select
                      selectedKey={preset}
                      onSelectionChange={(key) => applyPreset(String(key) as Preset)}
                      isDisabled={pending}
                      fullWidth
                    >
                      <Label>{t("preset.label")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("preset.label")}>
                          {(Object.keys(PRESETS) as Preset[]).map((key) => (
                            <ListBox.Item key={key} id={key} textValue={t("preset.option", { preset: key })}>
                              {t("preset.option", { preset: key })}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  )}
                  <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
                    <Label>{t("fields.name")}</Label>
                    <Input />
                  </TextField>
                  <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
                    <Label>{t("fields.description")}</Label>
                    <Input />
                  </TextField>
                  <Separator />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">{t("fields.rulesTitle")}</p>
                    <p className="text-sm text-muted">{t("fields.rulesHint")}</p>
                  </div>
                  <Switch isSelected={zdrOnly} onChange={setZdrOnly} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("fields.zdrOnly")}</Label>
                    </Switch.Content>
                    <Description>{t("fields.zdrOnlyHint")}</Description>
                  </Switch>
                  <Switch isSelected={noTrainingOnly} onChange={setNoTrainingOnly} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("fields.noTrainingOnly")}</Label>
                    </Switch.Content>
                    <Description>{t("fields.noTrainingOnlyHint")}</Description>
                  </Switch>
                  <TextField
                    fullWidth
                    value={retention}
                    onChange={setRetention}
                    isDisabled={pending}
                    isInvalid={days === undefined}
                  >
                    <Label>{t("fields.retention")}</Label>
                    <Input inputMode="numeric" />
                    <Description>{t("fields.retentionHint")}</Description>
                  </TextField>
                  <CheckboxGroup value={regions} onChange={setRegions} isDisabled={pending}>
                    <Label>{t("fields.regions")}</Label>
                    <Description>{t("fields.regionsHint")}</Description>
                    <div className="flex flex-wrap gap-4">
                      {DATA_REGIONS.map((region) => (
                        <Checkbox key={region} value={region}>
                          <Checkbox.Content>
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            {t("region", { region })}
                          </Checkbox.Content>
                        </Checkbox>
                      ))}
                    </div>
                  </CheckboxGroup>
                  <MultiPicker
                    label={t("fields.providers")}
                    description={t("fields.providersHint")}
                    placeholder={t("fields.providersPlaceholder")}
                    searchLabel={t("fields.search")}
                    emptyLabel={t("fields.noResults")}
                    items={providers.map((provider) => ({
                      id: provider.id,
                      label: provider.name,
                      detail: tProviders("kindName", { kind: provider.kind }),
                    }))}
                    selected={providerIds}
                    onChange={setProviderIds}
                    isDisabled={pending}
                  />
                  <TextField fullWidth value={patterns} onChange={setPatterns} isDisabled={pending}>
                    <Label>{t("fields.patterns")}</Label>
                    <Input placeholder="claude-*, gpt-4o*" />
                    <Description>{t("fields.patternsHint")}</Description>
                  </TextField>
                  <Separator />
                  <MultiPicker
                    label={t("fields.models")}
                    description={t("fields.modelsHint")}
                    placeholder={t("fields.modelsPlaceholder")}
                    searchLabel={t("fields.search")}
                    emptyLabel={t("fields.noResults")}
                    items={policies.map((policy) => ({ id: policy.alias, label: policy.alias }))}
                    selected={models}
                    onChange={setModels}
                    isDisabled={pending}
                  />
                  <Card variant="secondary">
                    <Card.Header>
                      <Card.Title>{t("preview.title")}</Card.Title>
                      <Card.Description>
                        {defined ? t("preview.summary", { count: matches.length }) : t("preview.empty")}
                      </Card.Description>
                    </Card.Header>
                    {matches.length ? (
                      <Card.Content className="space-y-2">
                        <TagGroup size="sm" aria-label={t("preview.title")}>
                          <TagGroup.List>
                            {matches.slice(0, PREVIEW_LIMIT).map((alias) => (
                              <Tag key={alias} id={alias}>
                                {alias}
                              </Tag>
                            ))}
                          </TagGroup.List>
                        </TagGroup>
                        {matches.length > PREVIEW_LIMIT ? (
                          <p className="text-xs text-muted">
                            {t("preview.more", { count: matches.length - PREVIEW_LIMIT })}
                          </p>
                        ) : null}
                      </Card.Content>
                    ) : null}
                  </Card>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!name.trim() || !defined || days === undefined}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("dialogSubmit", { mode })}
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
