"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  Disclosure,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  Select,
  Spinner,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { createModelGroupAction, updateModelGroupAction } from "@/app/(app)/models/_action";
import { isActionFail } from "@/lib/http/action-result";
import { scheduleOverlaps, validPrice, windowValid } from "@/lib/gateway/price-schedule";
import type {
  DeploymentDraft,
  DiscoveredPrice,
  Group,
  PriceWindowDraft,
  ProviderOpt,
} from "@/types/models";
import PriceScheduleFields from "./price-schedule-fields";

const BILLING_MODES = ["routed", "average", "custom"] as const;

type BillingMode = (typeof BILLING_MODES)[number];

function billingModeOf(value: string | undefined): BillingMode {
  return BILLING_MODES.find((mode) => mode === value) ?? "routed";
}


const STRATEGIES = [
  "weighted_random",
  "least_inflight",
  "cost_lowest",
  "fast",
  "priority",
] as const;

function catalogHit(
  providers: ProviderOpt[],
  providerId: string,
  model: string,
): DiscoveredPrice | null {
  const wanted = model.trim();
  if (!providerId || !wanted) return null;
  const rows = providers.find((p) => p.id === providerId)?.discovered ?? [];
  const hit =
    rows.find((row) => row.id === wanted) ??
    rows.find((row) => row.id.endsWith(`/${wanted}`)) ??
    null;
  if (!hit) return null;
  if (
    hit.priceSource === "provider" ||
    hit.costInputPer1k > 0 ||
    hit.costOutputPer1k > 0
  ) {
    return hit;
  }
  return null;
}

function withCatalogPrice(
  current: DeploymentDraft,
  patch: Partial<DeploymentDraft>,
  providers: ProviderOpt[],
): Partial<DeploymentDraft> {
  if (patch.model === undefined && patch.providerId === undefined) return patch;
  const next = { ...current, ...patch };
  const hit = catalogHit(providers, next.providerId, next.model);
  if (!hit) return patch;
  return {
    ...patch,
    costInput: String(hit.costInputPer1k),
    costOutput: String(hit.costOutputPer1k),
  };
}

function emptyDep(providers: ProviderOpt[]): DeploymentDraft {
  const p = providers.find((x) => x.hasApiKey) ?? providers[0];
  return {
    kind: p?.kind || "openai_compat",
    baseUrl: p?.baseUrl || "",
    model: "",
    weight: "1",
    costInput: "0",
    costOutput: "0",
    providerId: p?.id || "",
  };
}

function draftsOf(group: Group | null, providers: ProviderOpt[]): DeploymentDraft[] {
  if (!group?.deployments.length) return [emptyDep(providers)];
  return group.deployments.map((d) => ({
    id: d.id,
    kind: d.kind,
    baseUrl: d.baseUrl,
    model: d.model,
    weight: String(d.weight),
    costInput: String(d.costInput || 0),
    costOutput: String(d.costOutput || 0),
    providerId: d.providerId ?? "",
  }));
}

function ProviderSelect({
  dep,
  providers,
  withCatalog,
  isDisabled,
  onChange,
}: {
  dep: DeploymentDraft;
  providers: ProviderOpt[];
  withCatalog: boolean;
  isDisabled: boolean;
  onChange: (patch: Partial<DeploymentDraft>) => void;
}) {
  const t = useTranslations("Models");
  const tProviders = useTranslations("Providers");
  return (
    <Select
      selectedKey={dep.providerId || (dep.kind ? `kind:${dep.kind}` : "none")}
      onSelectionChange={(key) => {
        const raw = String(key);
        if (raw === "none") {
          onChange({ providerId: "", kind: "openai_compat" });
          return;
        }
        if (raw.startsWith("kind:")) {
          const nextKind = raw.slice(5);
          const spec = PROVIDER_CATALOG.find((k) => k.kind === nextKind);
          onChange({
            providerId: "",
            kind: nextKind,
            baseUrl: spec?.default_base_url || "",
          });
          return;
        }
        const p = providers.find((x) => x.id === raw);
        onChange({
          providerId: raw,
          kind: p?.kind || dep.kind,
          baseUrl: p?.baseUrl || dep.baseUrl,
        });
      }}
      isDisabled={isDisabled}
      aria-label={t("fields.provider")}
      fullWidth
    >
      <Label>{t("fields.provider")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("fields.provider")}>
          <ListBox.Item id="none" textValue={t("fields.noProvider")}>
            {t("fields.noProvider")}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {providers.map((p) => (
            <ListBox.Item key={p.id} id={p.id} textValue={p.name}>
              {p.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
          {withCatalog
            ? PROVIDER_CATALOG.filter((k) => !providers.some((p) => p.kind === k.kind)).map(
                (k) => (
                  <ListBox.Item
                    key={k.kind}
                    id={`kind:${k.kind}`}
                    textValue={tProviders("kindName", { kind: k.kind })}
                  >
                    {tProviders("kindName", { kind: k.kind })}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ),
              )
            : null}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export default function ModelGroupDialog({
  state,
  editing,
  providers,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: Group | null;
  providers: ProviderOpt[];
  onSaved: (group: Group) => void;
}) {
  const t = useTranslations("Models");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [alias, setAlias] = useState(editing?.alias ?? "gpt-4o");
  const [strategy, setStrategy] = useState(editing?.strategy || "least_inflight");
  const [retries, setRetries] = useState(String(editing?.numRetries ?? 2));
  const [overflow, setOverflow] = useState(editing?.overflowGroup ?? "");
  const [fallbacks, setFallbacks] = useState(editing?.fallbackGroups.join(", ") ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [billingMode, setBillingMode] = useState<BillingMode>(billingModeOf(editing?.billingMode));
  const [priceIn, setPriceIn] = useState(editing?.priceInput ?? 0);
  const [priceOut, setPriceOut] = useState(editing?.priceOutput ?? 0);
  const [priceTimeZone, setPriceTimeZone] = useState(editing?.priceTimeZone || "UTC");
  const [priceWindows, setPriceWindows] = useState<PriceWindowDraft[]>(
    () => editing?.priceWindows.map((w, i) => ({ ...w, key: i + 1 })) ?? [],
  );
  const [deps, setDeps] = useState<DeploymentDraft[]>(() => draftsOf(editing, providers));
  const [pending, start] = useTransition();
  const mode = editing ? "save" : "create";
  const customPrice = billingMode === "custom";
  const pricesValid =
    !customPrice ||
    (validPrice(priceIn) &&
      validPrice(priceOut) &&
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
        strategy,
        billingMode,
        priceInput: validPrice(priceIn) ? priceIn : undefined,
        priceOutput: validPrice(priceOut) ? priceOut : undefined,
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
        deployments: deps
          .filter((d) => d.model.trim())
          .map((d) => ({
            id: d.id,
            kind: d.kind.startsWith("kind:") ? d.kind.slice(5) : d.kind,
            baseUrl: d.baseUrl,
            model: d.model,
            weight: Number(d.weight) || 1,
            costInput: Number(d.costInput) || 0,
            costOutput: Number(d.costOutput) || 0,
            providerId:
              !d.providerId || d.providerId.startsWith("kind:") ? null : d.providerId,
          })),
      };
      const result = editing
        ? await updateModelGroupAction(body)
        : await createModelGroupAction(body);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("toasts.saved", { mode: editing ? "edit" : "add" }), { variant: "success" });
      close();
    });
  }

  const first = deps[0];

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-lg">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("formTitle", { mode: editing ? "edit" : "add" })}</Modal.Heading>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                  <p className="text-sm text-muted">{t("addHint")}</p>
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
                    <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
                      <NumberField
                        fullWidth
                        value={priceIn}
                        onChange={setPriceIn}
                        minValue={0}
                        formatOptions={formats.number.price}
                        isInvalid={!validPrice(priceIn)}
                        isDisabled={pending}
                      >
                        <Label>{t("fields.priceIn")}</Label>
                        <NumberField.Group>
                          <NumberField.Input />
                        </NumberField.Group>
                        {validPrice(priceIn) ? null : <FieldError>{t("priceInvalid")}</FieldError>}
                      </NumberField>
                      <NumberField
                        fullWidth
                        value={priceOut}
                        onChange={setPriceOut}
                        minValue={0}
                        formatOptions={formats.number.price}
                        isInvalid={!validPrice(priceOut)}
                        isDisabled={pending}
                      >
                        <Label>{t("fields.priceOut")}</Label>
                        <NumberField.Group>
                          <NumberField.Input />
                        </NumberField.Group>
                        {validPrice(priceOut) ? null : <FieldError>{t("priceInvalid")}</FieldError>}
                      </NumberField>
                      <p className="text-sm text-muted sm:col-span-2">{t("priceHint")}</p>
                      <PriceScheduleFields
                        windows={priceWindows}
                        timeZone={priceTimeZone}
                        basePrice={{ input: priceIn, output: priceOut }}
                        isDisabled={pending}
                        onWindowsChange={setPriceWindows}
                        onTimeZoneChange={setPriceTimeZone}
                      />
                    </div>
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
                        <TextField
                          fullWidth
                          value={overflow}
                          onChange={setOverflow}
                          isDisabled={pending}
                          aria-label={t("fields.overflow")}
                        >
                          <Label>{t("fields.overflow")}</Label>
                          <Input aria-label={t("fields.overflow")} />
                        </TextField>
                        <TextField
                          fullWidth
                          value={fallbacks}
                          onChange={setFallbacks}
                          isDisabled={pending}
                          aria-label={t("fields.fallbacks")}
                        >
                          <Label>{t("fields.fallbacks")}</Label>
                          <Input aria-label={t("fields.fallbacks")} />
                        </TextField>
                        {deps.map((d, i) => (
                          <Card key={d.id ?? i} variant="secondary">
                            {i > 0 ? (
                              <>
                                <ProviderSelect
                                  dep={d}
                                  providers={providers}
                                  withCatalog={false}
                                  isDisabled={pending}
                                  onChange={(patch) => setDep(i, patch)}
                                />
                                <TextField
                                  fullWidth
                                  value={d.model}
                                  onChange={(v) => setDep(i, { model: v })}
                                  isDisabled={pending}
                                  aria-label={t("fields.upstream")}
                                >
                                  <Label>{t("fields.upstream")}</Label>
                                  <Input aria-label={t("fields.upstream")} />
                                </TextField>
                              </>
                            ) : null}
                            <TextField
                              fullWidth
                              value={d.weight}
                              onChange={(v) => setDep(i, { weight: v })}
                              isDisabled={pending}
                              aria-label={t("fields.weight")}
                            >
                              <Label>{t("fields.weight")}</Label>
                              <Input aria-label={t("fields.weight")} />
                            </TextField>
                            <div className="grid grid-cols-2 gap-3">
                              <TextField
                                fullWidth
                                value={d.costInput}
                                onChange={(v) => setDep(i, { costInput: v })}
                                isDisabled={pending}
                                aria-label={t("fields.costIn")}
                              >
                                <Label>{t("fields.costIn")}</Label>
                                <Input aria-label={t("fields.costIn")} />
                              </TextField>
                              <TextField
                                fullWidth
                                value={d.costOutput}
                                onChange={(v) => setDep(i, { costOutput: v })}
                                isDisabled={pending}
                                aria-label={t("fields.costOut")}
                              >
                                <Label>{t("fields.costOut")}</Label>
                                <Input aria-label={t("fields.costOut")} />
                              </TextField>
                            </div>
                            {catalogHit(providers, d.providerId, d.model) ? (
                              <p className="text-sm text-muted">
                                {t("priceFromProvider", {
                                  source: providers.find((p) => p.id === d.providerId)?.name ?? "",
                                })}
                              </p>
                            ) : null}
                            {i > 0 ? (
                              <Button
                                size="sm"
                                variant="danger-soft"
                                aria-label={t("deleteEndpoint")}
                                isDisabled={pending}
                                onPress={() => setDeps((cur) => cur.filter((_, idx) => idx !== i))}
                              >
                                {t("deleteEndpoint")}
                              </Button>
                            ) : null}
                          </Card>
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
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="tertiary"
                    onPress={close}
                    isDisabled={pending}
                    aria-label={tCommon("cancel")}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    aria-label={t("formSubmit", { mode })}
                    isPending={pending}
                    isDisabled={!alias.trim() || !pricesValid}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("formSubmit", { mode })}
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
