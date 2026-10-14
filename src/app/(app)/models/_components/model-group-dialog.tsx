"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { modelRole, type ModelChoice } from "@/lib/models/model-role";
import { useErrorToast } from "@/components/console/use-error-toast";
import { createModelGroupAction, updateModelGroupAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";
import { scheduleOverlaps, validPrice, windowValid } from "@/lib/gateway/billing/price-schedule";
import type { DeploymentDraft, ModelGroupView, PriceWindowDraft, ProviderOpt } from "@/types/models";
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
import ProviderSelect from "./provider-select";

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
  const [alias, setAlias] = useState(editing?.alias ?? "gpt-4o");
  const [strategy, setStrategy] = useState(editing?.strategy || "least_inflight");
  const [retries, setRetries] = useState(String(editing?.numRetries ?? 2));
  const [overflow, setOverflow] = useState(editing?.overflowGroup ?? "");
  const [fallbacks, setFallbacks] = useState<string[]>(editing?.fallbackGroups ?? []);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [vendor, setVendor] = useState(editing?.vendor ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? "");
  const [autoRoutes, setAutoRoutes] = useState<boolean | null>(editing ? editing.autoRoutes : null);
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

  function setDep(i: number, patch: Partial<DeploymentDraft>) {
    setDeps((cur) =>
      cur.map((d, idx) => (idx === i ? { ...d, ...withCatalogPrice(d, patch, providers) } : d)),
    );
  }

  function save(close: () => void) {
    start(async () => {
      const body = {
        alias,
        enabled,
        vendor,
        displayName,
        autoRoutes,
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
      const result = editing
        ? await updateModelGroupAction(body)
        : await createModelGroupAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("toasts.saved", { mode: editing ? "edit" : "add" }), { variant: "success" });
      close();
    });
  }

  const first = deps[0];

  return (
    <FormDialog
      state={state}
      title={t("formTitle", { mode: editing ? "edit" : "add" })}
      description={t("addHint")}
      submitLabel={t("formSubmit", { mode })}
      pending={pending}
      isSubmitDisabled={!alias.trim() || !pricesValid}
      onSubmit={save}
    >
      <TextField
        fullWidth
        value={alias}
        onChange={(value) => setAlias(value.toLowerCase())}
        isDisabled={Boolean(editing) || pending}
        aria-label={t("fields.alias")}
      >
        <Label>{t("fields.alias")}</Label>
        <Input aria-label={t("fields.alias")} />
        <Description>{t("fields.aliasHint")}</Description>
      </TextField>
      {first ? (
        <>
          <ProviderSelect
            dep={first}
            providers={providers}
            withCatalog
            isDisabled={pending}
            onChange={(patch) => setDep(0, patch)}
          />
          <TextField
            fullWidth
            value={first.model}
            onChange={(v) => setDep(0, { model: v })}
            isDisabled={pending}
            aria-label={t("fields.upstream")}
          >
            <Label>{t("fields.upstream")}</Label>
            <Input aria-label={t("fields.upstream")} />
          </TextField>
          {first.providerId ? null : (
            <TextField
              fullWidth
              value={first.baseUrl}
              onChange={(v) => setDep(0, { baseUrl: v })}
              isDisabled={pending}
              aria-label={t("fields.baseUrl")}
            >
              <Label>{t("fields.baseUrl")}</Label>
              <Input aria-label={t("fields.baseUrl")} />
            </TextField>
          )}
        </>
      ) : null}
      <Select
        selectedKey={billingMode}
        onSelectionChange={(key) => setBillingMode(billingModeOf(String(key)))}
        isDisabled={pending}
        aria-label={t("fields.billingMode")}
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
              <ListBox.Item
                key={billing}
                id={billing}
                textValue={t(`billingModes.${billing}`)}
              >
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
      <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("fields.enabled")}</Label>
        </Switch.Content>
        <Description>{t("fields.enabledHint")}</Description>
      </Switch>
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
            {tCommon("advanced")}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="space-y-4 pt-3">
            <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
              <TextField fullWidth value={vendor} onChange={setVendor} isDisabled={pending}>
                <Label>{t("fields.vendor")}</Label>
                <Input placeholder="anthropic" />
                <Description>{t("fields.vendorHint")}</Description>
              </TextField>
              <TextField fullWidth value={displayName} onChange={setDisplayName} isDisabled={pending}>
                <Label>{t("fields.displayName")}</Label>
                <Input />
                <Description>{t("fields.displayNameHint")}</Description>
              </TextField>
            </div>
            <SearchSelect
              label={t("fields.autoRoutes")}
              description={t("fields.autoRoutesHint")}
              items={AUTO_ROUTE_MODES.map((mode) => ({
                id: mode,
                label: t("fields.autoRoutesMode", { mode }),
              }))}
              value={autoRoutes === null ? "inherit" : autoRoutes ? "on" : "off"}
              onChange={(mode) => setAutoRoutes(mode === "inherit" ? null : mode === "on")}
              isDisabled={pending}
            />
            <Select
              selectedKey={strategy}
              onSelectionChange={(key) => setStrategy(String(key))}
              isDisabled={pending}
              aria-label={t("fields.strategy")}
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
            <TextField
              fullWidth
              value={retries}
              onChange={setRetries}
              isDisabled={pending}
              aria-label={t("fields.retries")}
            >
              <Label>{t("fields.retries")}</Label>
              <Input aria-label={t("fields.retries")} />
            </TextField>
            <SearchSelect
              label={t("fields.overflow")}
              items={overflowItems}
              value={overflow || "none"}
              onChange={(next) => setOverflow(next === "none" ? "" : next)}
              isDisabled={pending}
            />
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
            {deps.map((d, i) => (
              <DeploymentCard
                key={d.id ?? i}
                dep={d}
                primary={i === 0}
                providers={providers}
                isDisabled={pending}
                onChange={(patch) => setDep(i, patch)}
                onRemove={() => setDeps((cur) => cur.filter((_, idx) => idx !== i))}
              />
            ))}
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("addEndpoint")}
              isDisabled={pending}
              onPress={() => setDeps((cur) => [...cur, emptyDep(providers)])}
            >
              {t("addEndpoint")}
            </Button>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </FormDialog>
  );
}
