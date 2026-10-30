"use client";

import {
  Alert,
  Card,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  NumberField,
  Radio,
  RadioGroup,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { Boxes, FolderKanban, ListChecks, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { formats } from "@/i18n/formats";
import { Link } from "@/i18n/routing";
import { useClock } from "@/lib/hooks/use-clock";
import { KEY_ENDPOINTS } from "@/lib/gateway/access/key-restrictions";
import { accessSummary, invalidIps, KEY_EXPIRY_DAYS } from "@/lib/keys/draft";
import type { KeyBindingKind, KeyDraft, KeyOptions } from "@/types/keys";
import { placeOf } from "./key-binding";

export type DraftChange = (patch: Partial<KeyDraft>) => void;

const KINDS: { id: KeyBindingKind; icon: LucideIcon }[] = [
  { id: "project", icon: FolderKanban },
  { id: "member", icon: UserRound },
  { id: "internal", icon: ShieldCheck },
];

const ACCESS_MODES: { id: "all" | "some"; icon: LucideIcon }[] = [
  { id: "all", icon: Boxes },
  { id: "some", icon: ListChecks },
];

const BUDGET_PERIODS = [
  { id: "none", value: "" },
  { id: "daily", value: "1d" },
  { id: "weekly", value: "7d" },
  { id: "monthly", value: "30d" },
] as const;

const SUMMARY_LIMIT = 12;

function choiceClass(selected: boolean) {
  return selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0";
}

function optionalNumber(value: number): number {
  return value > 0 ? value : Number.NaN;
}

function fromOptional(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function KeyNameField({
  value,
  onChange,
  isDisabled,
}: {
  value: string;
  onChange: (value: string) => void;
  isDisabled: boolean;
}) {
  const t = useTranslations("Keys");
  return (
    <TextField fullWidth isRequired autoFocus value={value} onChange={onChange} isDisabled={isDisabled} maxLength={80}>
      <Label>{t("fields.alias")}</Label>
      <Input placeholder={t("fields.aliasPlaceholder")} />
      <Description>{t("fields.aliasHint")}</Description>
    </TextField>
  );
}

export function BindingFields({
  draft,
  options,
  canBind,
  isDisabled,
  onChange,
}: {
  draft: KeyDraft;
  options: KeyOptions;
  canBind: boolean;
  isDisabled: boolean;
  onChange: DraftChange;
}) {
  const t = useTranslations("Keys");
  const scope = options.companyId ? "company" : "platform";
  const targets = draft.kind === "project" ? options.projects : options.members;
  const targetId = draft.kind === "project" ? draft.projectId : draft.memberId;

  if (!canBind) {
    return (
      <Alert status="accent">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t("binding.kind", { kind: "internal" })}</Alert.Title>
          <Alert.Description>{t("binding.locked")}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <RadioGroup
        value={draft.kind}
        onChange={(value) => {
          const next = KINDS.find((item) => item.id === value);
          if (next) onChange({ kind: next.id });
        }}
        isDisabled={isDisabled}
        className="gap-3"
      >
        <Label>{t("fields.binding")}</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {KINDS.map((item) => {
            const selected = item.id === draft.kind;
            return (
              <Card key={item.id} variant="secondary" className={choiceClass(selected)}>
                <Radio value={item.id} className="mt-0 h-full w-full">
                  <Radio.Content className="h-full w-full items-start gap-3 p-3">
                    <IconTile icon={item.icon} tone={selected ? "accent" : "neutral"} size="sm" />
                    <span className="min-w-0 flex-1 space-y-1">
                      <Label>{t("binding.kind", { kind: item.id })}</Label>
                      <span className="block text-xs font-normal text-muted">
                        {t("binding.short", { kind: item.id })}
                      </span>
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
        <Description>{t("binding.hint", { kind: draft.kind, scope })}</Description>
      </RadioGroup>
      {draft.kind === "internal" ? null : (
        <SearchSelect
          isRequired
          label={t("binding.kind", { kind: draft.kind })}
          placeholder={t("binding.pick", { kind: draft.kind })}
          items={targets.map((target) => {
            const place = placeOf(options, target.orgId, target.teamId);
            return {
              id: target.id,
              label: target.alias,
              detail: t("binding.place", { org: place.org, team: place.team, hasTeam: place.team ? "yes" : "no" }),
            };
          })}
          value={targetId}
          onChange={(next) => onChange(draft.kind === "project" ? { projectId: next } : { memberId: next })}
          isDisabled={isDisabled || targets.length === 0}
          description={targets.length ? t("binding.targetHint", { kind: draft.kind }) : t("binding.empty", { kind: draft.kind })}
        />
      )}
    </div>
  );
}

export function AccessSummaryCard({ draft, options }: { draft: Pick<KeyDraft, "restricted" | "models" | "templateIds">; options: Pick<KeyOptions, "templates" | "models"> }) {
  const t = useTranslations("Keys");
  const summary = accessSummary(draft, options.templates);

  if (draft.restricted && !draft.models.length && !draft.templateIds.length) {
    return (
      <Card variant="secondary">
        <Card.Content>
          <p className="text-sm text-muted">{t("accessSummary.pick")}</p>
        </Card.Content>
      </Card>
    );
  }

  if (summary.state === "none") {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t("access", { state: "none", count: 0 })}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const shown = summary.models.slice(0, SUMMARY_LIMIT);
  return (
    <Card variant="secondary">
      <Card.Content className="space-y-2">
        <p className="text-sm text-foreground">
          {summary.state === "all"
            ? t("accessSummary.all", { count: options.models.length })
            : t("accessSummary.some", { count: summary.models.length })}
        </p>
        {shown.length ? (
          <div className="flex flex-wrap gap-1">
            {shown.map((model) => (
              <Chip key={model} size="sm" variant="soft">
                <span className="break-all">{model}</span>
              </Chip>
            ))}
            {summary.models.length > shown.length ? (
              <Chip size="sm" variant="soft">
                {t("accessSummary.more", { count: summary.models.length - shown.length })}
              </Chip>
            ) : null}
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}

export function ModelAccessFields({
  draft,
  options,
  isDisabled,
  onChange,
}: {
  draft: KeyDraft;
  options: KeyOptions;
  isDisabled: boolean;
  onChange: DraftChange;
}) {
  const t = useTranslations("Keys");
  const tTemplates = useTranslations("ModelTemplates");
  const mode = draft.restricted ? "some" : "all";

  return (
    <div className="space-y-4">
      <RadioGroup
        value={mode}
        onChange={(value) => onChange({ restricted: value === "some" })}
        isDisabled={isDisabled}
        className="gap-3"
      >
        <Label>{t("fields.access")}</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          {ACCESS_MODES.map((item) => {
            const selected = item.id === mode;
            return (
              <Card key={item.id} variant="secondary" className={choiceClass(selected)}>
                <Radio value={item.id} className="mt-0 h-full w-full">
                  <Radio.Content className="h-full w-full items-start gap-3 p-3">
                    <IconTile icon={item.icon} tone={selected ? "accent" : "neutral"} size="sm" />
                    <span className="min-w-0 flex-1 space-y-1">
                      <Label>{t("accessMode.title", { mode: item.id })}</Label>
                      <span className="block text-xs font-normal text-muted">{t("accessMode.hint", { mode: item.id })}</span>
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
      {draft.restricted ? (
        <div className="space-y-4">
          <MultiPicker
            label={t("fields.templates")}
            description={
              options.canTemplates
                ? t.rich("fields.templatesHint", {
                    link: (chunks) => (
                      <Link href="/models?tab=presets" className="text-accent">
                        {chunks}
                      </Link>
                    ),
                  })
                : t("fields.templatesNote")
            }
            placeholder={t("fields.templatesPlaceholder")}
            searchLabel={t("fields.search")}
            emptyLabel={t("fields.noResults")}
            items={options.templates.map((template) => ({
              id: template.id,
              label: template.name,
              detail: [template.description, tTemplates("matchCount", { count: template.matches.length })]
                .filter(Boolean)
                .join(" · "),
            }))}
            selected={draft.templateIds}
            onChange={(templateIds) => onChange({ templateIds })}
            isDisabled={isDisabled}
          />
          <MultiPicker
            label={t("fields.models")}
            description={t("fields.modelsHint")}
            placeholder={t("fields.modelsPlaceholder")}
            searchLabel={t("fields.search")}
            emptyLabel={t("fields.noResults")}
            items={options.models.map((alias) => ({ id: alias, label: alias }))}
            selected={draft.models}
            onChange={(models) => onChange({ models })}
            isDisabled={isDisabled}
          />
        </div>
      ) : null}
      <AccessSummaryCard draft={draft} options={options} />
    </div>
  );
}

export function RateLimitFields({
  draft,
  isDisabled,
  onChange,
}: {
  draft: KeyDraft;
  isDisabled: boolean;
  onChange: DraftChange;
}) {
  const t = useTranslations("Keys");
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <NumberField
          fullWidth
          value={optionalNumber(draft.rpm)}
          onChange={(value) => onChange({ rpm: fromOptional(value) })}
          minValue={0}
          step={1}
          formatOptions={formats.number.integer}
          isDisabled={isDisabled}
        >
          <Label>{t("fields.rpm")}</Label>
          <NumberField.Group>
            <NumberField.Input placeholder={t("fields.unlimited")} />
          </NumberField.Group>
          <Description>{t("fields.rpmHint")}</Description>
        </NumberField>
        <NumberField
          fullWidth
          value={optionalNumber(draft.tpm)}
          onChange={(value) => onChange({ tpm: fromOptional(value) })}
          minValue={0}
          step={1000}
          formatOptions={formats.number.integer}
          isDisabled={isDisabled}
        >
          <Label>{t("fields.tpm")}</Label>
          <NumberField.Group>
            <NumberField.Input placeholder={t("fields.unlimited")} />
          </NumberField.Group>
          <Description>{t("fields.tpmHint")}</Description>
        </NumberField>
      </div>
      <NumberField
        fullWidth
        value={optionalNumber(draft.maxRequestCost)}
        onChange={(value) => onChange({ maxRequestCost: fromOptional(value) })}
        minValue={0}
        step={0.01}
        formatOptions={formats.number.price}
        isDisabled={isDisabled}
      >
        <Label>{t("fields.maxRequestCost")}</Label>
        <NumberField.Group>
          <NumberField.Input placeholder={t("fields.unlimited")} />
        </NumberField.Group>
        <Description>{t("fields.maxRequestCostHint")}</Description>
      </NumberField>
    </div>
  );
}

export function BudgetFields({
  draft,
  isDisabled,
  onChange,
}: {
  draft: KeyDraft;
  isDisabled: boolean;
  onChange: DraftChange;
}) {
  const t = useTranslations("Keys");
  const tBudgets = useTranslations("Budgets");
  const periodLabel = useId();
  const capped = draft.budget > 0;
  return (
    <div className="space-y-3">
      <NumberField
        fullWidth
        value={optionalNumber(draft.budget)}
        onChange={(value) => onChange({ budget: fromOptional(value) })}
        minValue={0}
        formatOptions={formats.number.currency}
        isDisabled={isDisabled}
      >
        <Label>{t("fields.budget")}</Label>
        <NumberField.Group>
          <NumberField.Input placeholder={t("fields.unlimited")} />
        </NumberField.Group>
        <Description>{t("fields.budgetHint")}</Description>
      </NumberField>
      {capped ? (
        <div className="space-y-2">
          <p id={periodLabel} className="text-sm font-medium text-foreground">
            {tBudgets("period")}
          </p>
          <ToggleButtonGroup
            fullWidth
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            aria-labelledby={periodLabel}
            selectedKeys={[BUDGET_PERIODS.find((item) => item.value === draft.budgetPeriod)?.id ?? "none"]}
            onSelectionChange={(keys) => {
              const next = BUDGET_PERIODS.find((item) => item.id === [...keys][0]);
              if (next) onChange({ budgetPeriod: next.value });
            }}
            isDisabled={isDisabled}
          >
            {BUDGET_PERIODS.map((item, index) => (
              <ToggleButton key={item.id} id={item.id}>
                {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                {tBudgets("periods", { period: item.id })}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <p className="text-xs text-muted">{tBudgets("periodHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ExpiryField({
  days,
  isDisabled,
  onChange,
}: {
  days: number;
  isDisabled: boolean;
  onChange: (days: number) => void;
}) {
  const t = useTranslations("Keys");
  const format = useFormatter();
  const now = useClock(60_000);
  const label = useId();
  return (
    <div className="space-y-2">
      <p id={label} className="text-sm font-medium text-foreground">
        {t("fields.expiry")}
      </p>
      <ToggleButtonGroup
        fullWidth
        size="sm"
        selectionMode="single"
        disallowEmptySelection
        aria-labelledby={label}
        selectedKeys={[String(days)]}
        onSelectionChange={(keys) => {
          const next = KEY_EXPIRY_DAYS.find((item) => String(item) === [...keys][0]);
          if (next !== undefined) onChange(next);
        }}
        isDisabled={isDisabled}
      >
        {KEY_EXPIRY_DAYS.map((item, index) => (
          <ToggleButton key={item} id={String(item)}>
            {index > 0 ? <ToggleButtonGroup.Separator /> : null}
            {t("fields.expiryOption", { days: item })}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <p className="text-xs text-muted">
        {days > 0
          ? t("fields.expiryOn", { date: format.dateTime(new Date(now.getTime() + days * 86_400_000), "short") })
          : t("fields.expiryNever")}
      </p>
    </div>
  );
}

export function IpAllowlistField({
  value,
  isDisabled,
  onChange,
}: {
  value: string;
  isDisabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("Keys");
  const format = useFormatter();
  const invalid = invalidIps(value);
  return (
    <TextField fullWidth value={value} onChange={onChange} isDisabled={isDisabled} isInvalid={invalid.length > 0}>
      <Label>{t("fields.allowedIps")}</Label>
      <TextArea rows={3} placeholder="203.0.113.10" />
      {invalid.length ? (
        <FieldError>{t("fields.allowedIpsInvalid", { ips: format.list(invalid, { type: "conjunction" }) })}</FieldError>
      ) : (
        <Description>{t("fields.allowedIpsHint")}</Description>
      )}
    </TextField>
  );
}

export function EndpointsField({
  draft,
  isDisabled,
  onChange,
}: {
  draft: KeyDraft;
  isDisabled: boolean;
  onChange: DraftChange;
}) {
  const t = useTranslations("Keys");
  return (
    <MultiPicker
      label={t("fields.endpoints")}
      description={t("fields.endpointsHint")}
      placeholder={t("fields.endpointsPlaceholder")}
      searchLabel={t("fields.search")}
      emptyLabel={t("fields.noResults")}
      items={KEY_ENDPOINTS.map((endpoint) => ({
        id: endpoint,
        label: t("endpoints.name", { endpoint }),
        detail: t("endpoints.paths", { endpoint }),
      }))}
      selected={draft.endpoints}
      onChange={(ids) => onChange({ endpoints: KEY_ENDPOINTS.filter((endpoint) => ids.includes(endpoint)) })}
      isDisabled={isDisabled}
    />
  );
}

export function KeySwitchField({
  label,
  description,
  isSelected,
  isDisabled,
  onChange,
}: {
  label: string;
  description: string;
  isSelected: boolean;
  isDisabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Switch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>{label}</Label>
      </Switch.Content>
      <Description>{description}</Description>
    </Switch>
  );
}
