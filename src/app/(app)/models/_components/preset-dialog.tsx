"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  FieldError,
  Fieldset,
  Input,
  Label,
  Radio,
  RadioGroup,
  Separator,
  Switch,
  Tag,
  TagGroup,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { BookX, Boxes, MapPin, Server, ShieldCheck, SquareDashed, Timer, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import IconTile from "@/components/console/icon-tile";
import MultiPicker from "@/components/console/multi-picker";
import { useErrorToast } from "@/components/console/use-error-toast";
import { DATA_REGIONS, hasRules, templateModels } from "@/lib/gateway/access/model-policy";
import { isActionFail } from "@/lib/http/action-result";
import type { ModelPolicy, ModelTemplateView, TemplateProviderOption, TemplateRules } from "@/types/model-templates";
import { createTemplateAction, updateTemplateAction } from "../_action";

const STARTERS = {
  blank: { icon: SquareDashed, rules: {} },
  zdr: { icon: ShieldCheck, rules: { zdrOnly: true } },
  eu: { icon: MapPin, rules: { regions: ["eu"] } },
  noTraining: { icon: BookX, rules: { noTrainingOnly: true } },
  shortRetention: { icon: Timer, rules: { maxRetentionDays: 30 } },
} satisfies Record<string, { icon: LucideIcon; rules: Partial<TemplateRules> }>;

type Starter = keyof typeof STARTERS;

const STARTER_IDS = Object.keys(STARTERS) as Starter[];

const PREVIEW_LIMIT = 40;

const MAX_RETENTION_DAYS = 3650;

function isStarter(value: unknown): value is Starter {
  return STARTER_IDS.some((id) => id === value);
}

function splitPatterns(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseDays(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,4}$/.test(trimmed)) return undefined;
  const days = Number(trimmed);
  return days <= MAX_RETENTION_DAYS ? days : undefined;
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  const hintId = useId();
  return (
    <Fieldset className="gap-4" aria-describedby={hintId}>
      <Fieldset.Legend className="flex items-center gap-2.5">
        <IconTile icon={icon} size="sm" />
        {title}
      </Fieldset.Legend>
      <p id={hintId} className="text-sm text-muted">
        {hint}
      </p>
      {children}
    </Fieldset>
  );
}

export default function PresetDialog({
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
  const showError = useErrorToast();
  const [starter, setStarter] = useState<Starter>("blank");
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
  const known = new Set(providers.map((provider) => provider.id));
  const removed = providerIds.filter((id) => !known.has(id));
  const providerItems = [
    ...providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      detail: tProviders("kindName", { kind: provider.kind }),
    })),
    ...removed.map((id) => ({ id, label: t("fields.removedProvider"), detail: id })),
  ];

  function applyStarter(next: Starter) {
    const preset: Partial<TemplateRules> = STARTERS[next].rules;
    setStarter(next);
    setRegions(preset.regions ?? []);
    setZdrOnly(preset.zdrOnly ?? false);
    setNoTrainingOnly(preset.noTrainingOnly ?? false);
    setRetention(preset.maxRetentionDays === undefined ? "" : String(preset.maxRetentionDays));
    if (!name.trim() || name === t("preset.name", { preset: starter })) setName(t("preset.name", { preset: next }));
  }

  function save(close: () => void) {
    start(async () => {
      const body = { name, description, ...rules };
      const result = editing
        ? await updateTemplateAction({ ...body, id: editing.id })
        : await createTemplateAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.template);
      toast(t("toasts.saved", { mode }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("dialogTitle", { mode })}
      description={t("dialogDescription")}
      submitLabel={t("dialogSubmit", { mode })}
      pending={pending}
      isSubmitDisabled={!name.trim() || !defined || days === undefined}
      onSubmit={save}
    >
      {editing ? null : (
        <RadioGroup
          value={starter}
          onChange={(next) => {
            if (isStarter(next)) applyStarter(next);
          }}
          isDisabled={pending}
          className="gap-2"
        >
          <Label>{t("preset.label")}</Label>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
            {STARTER_IDS.map((id) => {
              const selected = id === starter;
              return (
                <Card
                  key={id}
                  variant="secondary"
                  className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
                >
                  <Radio value={id} className="mt-0 h-full w-full">
                    <Radio.Content className="h-full w-full items-start gap-3 p-3">
                      <IconTile icon={STARTERS[id].icon} tone={selected ? "accent" : "neutral"} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium break-words">{t("preset.option", { preset: id })}</span>
                        <span className="mt-0.5 block text-xs text-muted">{t("preset.hint", { preset: id })}</span>
                      </span>
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                    </Radio.Content>
                  </Radio>
                </Card>
              );
            })}
          </div>
        </RadioGroup>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending} maxLength={80}>
          <Label>{t("fields.name")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending} maxLength={300}>
          <Label>{t("fields.description")}</Label>
          <Input placeholder={t("fields.descriptionPlaceholder")} />
        </TextField>
      </div>

      <Separator />

      <Section icon={Boxes} title={t("sections.models.title")} hint={t("sections.models.hint")}>
        <TextField fullWidth value={patterns} onChange={setPatterns} isDisabled={pending}>
          <Label>{t("fields.patterns")}</Label>
          <Input placeholder="claude-*, gpt-4o*" />
          <Description>{t("fields.patternsHint")}</Description>
        </TextField>
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
      </Section>

      <Separator />

      <Section icon={Server} title={t("sections.providers.title")} hint={t("sections.providers.hint")}>
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
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
        </div>
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <TextField
            fullWidth
            value={retention}
            onChange={setRetention}
            isDisabled={pending}
            isInvalid={days === undefined}
          >
            <Label>{t("fields.retention")}</Label>
            <Input inputMode="numeric" placeholder={t("fields.retentionPlaceholder")} />
            <Description>{t("fields.retentionHint")}</Description>
            <FieldError>{t("fields.retentionInvalid", { max: MAX_RETENTION_DAYS })}</FieldError>
          </TextField>
          <CheckboxGroup value={regions} onChange={setRegions} isDisabled={pending}>
            <Label>{t("fields.regions")}</Label>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
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
            <Description>{t("fields.regionsHint")}</Description>
          </CheckboxGroup>
        </div>
        <MultiPicker
          label={t("fields.providers")}
          description={t("fields.providersHint")}
          placeholder={t("fields.providersPlaceholder")}
          searchLabel={t("fields.search")}
          emptyLabel={t("fields.noResults")}
          items={providerItems}
          selected={providerIds}
          onChange={setProviderIds}
          isDisabled={pending}
        />
        {removed.length ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t("removed.title", { count: removed.length })}</Alert.Title>
              <Alert.Description>{t("removed.description", { count: removed.length })}</Alert.Description>
            </Alert.Content>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={pending}
              onPress={() => setProviderIds((current) => current.filter((id) => known.has(id)))}
            >
              {t("removed.action", { count: removed.length })}
            </Button>
          </Alert>
        ) : null}
      </Section>

      <Card variant="secondary">
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Card.Title>{t("preview.title")}</Card.Title>
            <Card.Description>
              {defined ? t("preview.summary", { count: matches.length }) : t("preview.empty")}
            </Card.Description>
          </div>
          {defined ? (
            <Chip size="sm" variant="soft" color={matches.length ? "success" : "warning"}>
              {t("matchCount", { count: matches.length })}
            </Chip>
          ) : null}
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
              <p className="text-xs text-muted">{t("preview.more", { count: matches.length - PREVIEW_LIMIT })}</p>
            ) : null}
          </Card.Content>
        ) : null}
      </Card>
    </FormDialog>
  );
}
