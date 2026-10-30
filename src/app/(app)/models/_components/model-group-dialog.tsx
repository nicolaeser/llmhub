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
  Select,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Plus, Route } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import StepDialog, { type DialogStep } from "@/components/console/step-dialog";
import { modelRole, type ModelChoice } from "@/lib/models/model-role";
import { useErrorToast } from "@/components/console/use-error-toast";
import { createModelGroupAction, updateModelGroupAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";
import { scheduleOverlaps, validPrice, windowValid } from "@/lib/gateway/billing/price-schedule";
import { MODEL_VARIANTS, variantAlias } from "@/lib/gateway/catalog/model-variants";
import type { DeploymentDraft, ModelGroupView, ModelVariant, PriceWindowDraft, ProviderOpt } from "@/types/models";
import CustomPriceFields from "./custom-price-fields";
import DeploymentCard from "./deployment-card";
import {
  BILLING_MODES,
  billingModeOf,
  deploymentInput,
  draftsOf,
  emptyDep,
  withCatalogPrice,
  type BillingMode,
} from "./deployment-draft";
import { DEFAULT_STRATEGY } from "./group-summary";
import { useGroupSummary } from "./use-group-summary";

const AUTO_ROUTE_MODES = ["inherit", "on", "off"] as const;

const STRATEGIES = [
  "weighted_random",
  "least_inflight",
  "cost_lowest",
  "fast",
  "priority",
  "round_robin",
  "quota_balanced",
  "quota_expiring",
  "smart",
] as const;

export default function ModelGroupDialog({
  state,
  editing,
  providers,
  models,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: ModelGroupView | null;
  providers: ProviderOpt[];
  models: ModelChoice[];
  onSaved: (group: ModelGroupView) => void;
}) {
  const t = useTranslations("Models");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const summarize = useGroupSummary(providers);
  const [alias, setAlias] = useState(editing?.alias ?? "");
  const [strategy, setStrategy] = useState(editing?.strategy || DEFAULT_STRATEGY);
  const [retries, setRetries] = useState(String(editing?.numRetries ?? 2));
  const [overflow, setOverflow] = useState(editing?.overflowGroup ?? "");
  const [fallbacks, setFallbacks] = useState<string[]>(editing?.fallbackGroups ?? []);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [vendor, setVendor] = useState(editing?.vendor ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? "");
  const [autoRoutes, setAutoRoutes] = useState<boolean | null>(editing ? editing.autoRoutes : null);
  const [variants, setVariants] = useState<ModelVariant[]>(editing?.variants ?? []);
  const [billingMode, setBillingMode] = useState<BillingMode>(billingModeOf(editing?.billingMode));
  const [price, setPrice] = useState({ input: editing?.priceInput ?? 0, output: editing?.priceOutput ?? 0 });
  const [priceTimeZone, setPriceTimeZone] = useState(editing?.priceTimeZone || "UTC");
  const [priceWindows, setPriceWindows] = useState<PriceWindowDraft[]>(
    () => editing?.priceWindows.map((w, i) => ({ ...w, key: i + 1 })) ?? [],
  );
  const [deps, setDeps] = useState<DeploymentDraft[]>(() => draftsOf(editing, providers));
  const [pending, start] = useTransition();
  const mode = editing ? "save" : "create";
  const currentRole = modelRole([...deps.map((dep) => dep.model), alias, displayName]);
  const known = new Map(models.map((model) => [model.alias, model]));
  const sameKind = models.filter((model) => model.alias !== alias && model.role === currentRole);
  const kept = [...new Set([overflow, ...fallbacks].filter(Boolean))].filter(
    (id) => id !== alias && !sameKind.some((model) => model.alias === id),
  );
  const otherModels = [
    ...sameKind,
    ...kept.map((id) => known.get(id) ?? { alias: id, label: id, role: currentRole }),
  ];
  const modelOption = (model: ModelChoice) => ({
    id: model.alias,
    label: model.label,
    detail: model.label === model.alias ? undefined : model.alias,
  });
  const overflowItems = [{ id: "none", label: tCommon("none") }, ...otherModels.map(modelOption)];
  const customPrice = billingMode === "custom";
  const pricesValid =
    !customPrice ||
    (validPrice(price.input) &&
      validPrice(price.output) &&
      priceWindows.every(windowValid) &&
      !scheduleOverlaps(priceWindows));
  const preview = summarize({
    deployments: deps.map((dep) => ({ providerId: dep.providerId || null, kind: dep.kind, model: dep.model })),
    strategy,
    fallbackGroups: fallbacks,
    overflowGroup: overflow,
    billingMode,
    priceInput: price.input,
    priceOutput: price.output,
    priceWindows: priceWindows.length,
  });

  function setDep(i: number, patch: Partial<DeploymentDraft>) {
    setDeps((cur) => cur.map((d, idx) => (idx === i ? { ...d, ...withCatalogPrice(d, patch, providers) } : d)));
  }

  function save(close: () => void) {
    start(async () => {
      const body = {
        alias,
        enabled,
        vendor,
        displayName,
        autoRoutes,
        variants,
        strategy,
        billingMode,
        priceInput: validPrice(price.input) ? price.input : undefined,
        priceOutput: validPrice(price.output) ? price.output : undefined,
        priceTimeZone: customPrice ? priceTimeZone : undefined,
        priceWindows: customPrice
          ? priceWindows.map((w) => ({
              start: w.start,
              end: w.end,
              priceInput: w.priceInput,
              priceOutput: w.priceOutput,
            }))
          : undefined,
        numRetries: Number(retries) || 0,
        overflowGroup: overflow,
        fallbackGroups: fallbacks,
        deployments: deps.filter((d) => d.model.trim()).map(deploymentInput),
      };
      const result = editing ? await updateModelGroupAction(body) : await createModelGroupAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("toasts.saved", { mode: editing ? "edit" : "add" }), { variant: "success" });
      close();
    });
  }

  const previewCard = (
    <Card variant="secondary" className="flex-row items-start gap-3" aria-live="polite">
      <IconTile icon={Route} size="sm" tone={preview.summary.spread === "none" ? "warning" : "accent"} />
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-muted">{t("previewTitle", { alias: alias.trim() || "alias" })}</p>
        <p className="text-sm break-words text-foreground">{preview.sentence}</p>
        {preview.pricing ? <p className="text-xs break-words text-muted">{preview.pricing}</p> : null}
      </div>
    </Card>
  );

  const nameStep: DialogStep = {
    id: "name",
    title: t("steps.name.title"),
    description: t("steps.name.description"),
    isValid: Boolean(alias.trim()),
    content: (
      <>
        <TextField
          fullWidth
          isRequired
          autoFocus={!editing}
          value={alias}
          onChange={(value) => setAlias(value.toLowerCase())}
          isDisabled={Boolean(editing) || pending}
        >
          <Label>{t("fields.alias")}</Label>
          <Input placeholder="gpt-5.5" />
          <Description>{t("fields.aliasHint")}</Description>
        </TextField>
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <TextField fullWidth value={displayName} onChange={setDisplayName} isDisabled={pending}>
            <Label>{t("fields.displayName")}</Label>
            <Input />
            <Description>{t("fields.displayNameHint")}</Description>
          </TextField>
          <TextField fullWidth value={vendor} onChange={setVendor} isDisabled={pending}>
            <Label>{t("fields.vendor")}</Label>
            <Input placeholder="anthropic" />
            <Description>{t("fields.vendorHint")}</Description>
          </TextField>
        </div>
      </>
    ),
  };

  const endpointsStep: DialogStep = {
    id: "endpoints",
    title: t("steps.endpoints.title"),
    description: t("steps.endpoints.description"),
    optional: Boolean(editing),
    content: (
      <>
        {deps.map((d, i) => (
          <DeploymentCard
            key={d.id ?? i}
            index={i}
            dep={d}
            withCatalog={i === 0}
            showWeight={deps.length > 1}
            removable={deps.length > 1}
            providers={providers}
            isDisabled={pending}
            onChange={(patch) => setDep(i, patch)}
            onRemove={() => setDeps((cur) => cur.filter((_, idx) => idx !== i))}
          />
        ))}
        <div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={pending}
            onPress={() => setDeps((cur) => [...cur, emptyDep(providers)])}
          >
            <Plus size={14} aria-hidden />
            {t("addEndpoint")}
          </Button>
        </div>
        {deps.length > 1 ? (
          <Select
            selectedKey={strategy}
            onSelectionChange={(key) => setStrategy(String(key))}
            isDisabled={pending}
            fullWidth
          >
            <Label>{t("fields.strategy")}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label={t("fields.strategy")}>
                {STRATEGIES.map((s) => (
                  <ListBox.Item key={s} id={s} textValue={t(`strategies.${s}`)}>
                    {t(`strategies.${s}`)}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>{t("strategyHint", { strategy })}</Description>
          </Select>
        ) : null}
        {previewCard}
      </>
    ),
  };

  const fallbacksStep: DialogStep = {
    id: "fallbacks",
    title: t("steps.fallbacks.title"),
    description: t("steps.fallbacks.description"),
    optional: true,
    content: (
      <>
        <MultiPicker
          label={t("fields.fallbacks")}
          placeholder={t("fields.fallbacksPlaceholder")}
          searchLabel={tCommon("search")}
          emptyLabel={tCommon("noResults")}
          items={otherModels.map(modelOption)}
          selected={fallbacks}
          onChange={setFallbacks}
          isDisabled={pending}
        />
        <SearchSelect
          label={t("fields.overflow")}
          description={t("fields.overflowHint")}
          items={overflowItems}
          value={overflow || "none"}
          onChange={(next) => setOverflow(next === "none" ? "" : next)}
          isDisabled={pending}
        />
        <TextField fullWidth value={retries} onChange={setRetries} isDisabled={pending}>
          <Label>{t("fields.retries")}</Label>
          <Input inputMode="numeric" />
          <Description>{t("fields.retriesHint")}</Description>
        </TextField>
        {previewCard}
      </>
    ),
  };

  const pricingStep: DialogStep = {
    id: "pricing",
    title: t("steps.pricing.title"),
    description: t("steps.pricing.description"),
    optional: true,
    isValid: pricesValid,
    content: (
      <>
        <Select
          selectedKey={billingMode}
          onSelectionChange={(key) => setBillingMode(billingModeOf(String(key)))}
          isDisabled={pending}
          fullWidth
        >
          <Label>{t("fields.billingMode")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("fields.billingMode")}>
              {BILLING_MODES.map((billing) => (
                <ListBox.Item key={billing} id={billing} textValue={t(`billingModes.${billing}`)}>
                  {t("billingModeLabel", { mode: billing })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{t("billingModeHint", { mode: billingMode })}</Description>
        </Select>
        {customPrice ? (
          <CustomPriceFields
            price={price}
            windows={priceWindows}
            timeZone={priceTimeZone}
            isDisabled={pending}
            onPriceChange={setPrice}
            onWindowsChange={setPriceWindows}
            onTimeZoneChange={setPriceTimeZone}
          />
        ) : null}
      </>
    ),
  };

  const advancedStep: DialogStep = {
    id: "advanced",
    title: t("steps.advanced.title"),
    description: t("steps.advanced.description"),
    optional: true,
    content: (
      <>
        <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("fields.enabled")}</Label>
          </Switch.Content>
          <Description>{t("fields.enabledHint")}</Description>
        </Switch>
        <SearchSelect
          label={t("fields.autoRoutes")}
          description={t("fields.autoRoutesHint")}
          items={AUTO_ROUTE_MODES.map((option) => ({
            id: option,
            label: t("fields.autoRoutesMode", { mode: option }),
          }))}
          value={autoRoutes === null ? "inherit" : autoRoutes ? "on" : "off"}
          onChange={(option) => setAutoRoutes(option === "inherit" ? null : option === "on")}
          isDisabled={pending}
        />
        <CheckboxGroup
          value={variants}
          onChange={(next) => setVariants(MODEL_VARIANTS.filter((variant) => next.includes(variant)))}
          isDisabled={pending}
        >
          <Label>{t("fields.variants")}</Label>
          <Description>{t("fields.variantsHint")}</Description>
          {MODEL_VARIANTS.map((variant) => (
            <Checkbox key={variant} value={variant}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{t("fields.variantLabel", { variant, alias: variantAlias(alias.trim() || "alias", variant) })}</Label>
              </Checkbox.Content>
              <Description>{t("fields.variantHint", { variant })}</Description>
            </Checkbox>
          ))}
        </CheckboxGroup>
      </>
    ),
  };

  return (
    <StepDialog
      state={state}
      size="lg"
      title={editing ? t("formTitle", { mode: "edit" }) : t("formTitle", { mode: "add" })}
      description={editing ? editing.alias : t("addHint")}
      steps={[nameStep, endpointsStep, fallbacksStep, pricingStep, advancedStep]}
      submitLabel={t("formSubmit", { mode })}
      pending={pending}
      isSubmitDisabled={!alias.trim() || !pricesValid}
      onSubmit={save}
    />
  );
}
