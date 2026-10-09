"use client";

import { useId, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  Select,
  Separator,
  Spinner,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { saveMarkupAction } from "@/app/(app)/markups/_action";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import {
  applyMarkup,
  isModelPattern,
  MARKUP_SCOPES,
  MAX_MARKUP_PERCENT,
  MIN_MARKUP_PERCENT,
  marginShare,
} from "@/lib/gateway/markup-policy";
import type { PickerItem } from "@/types/console";
import type {
  MarkupKind,
  MarkupModelMode,
  MarkupOrgOption,
  MarkupProjectOption,
  MarkupScope,
  MarkupTeamOption,
  MarkupView,
} from "@/types/pricing";

const KINDS = ["markup", "discount"] as const satisfies readonly MarkupKind[];

const MODEL_MODES = ["all", "one", "pattern"] as const satisfies readonly MarkupModelMode[];

const PRESETS = [0.05, 0.1, 0.15, 0.2, 0.25];

const EXAMPLE_PURCHASE = 100;

function modelModeOf(model: string): MarkupModelMode {
  if (!model) return "all";
  return isModelPattern(model) ? "pattern" : "one";
}

export default function MarkupDialog({
  state,
  editing,
  orgs,
  teams,
  projects,
  models,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: MarkupView | null;
  orgs: MarkupOrgOption[];
  teams: MarkupTeamOption[];
  projects: MarkupProjectOption[];
  models: string[];
  onSaved: (markup: MarkupView) => void;
}) {
  const t = useTranslations("Markups");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const modelModeLabel = useId();
  const kindLabel = useId();
  const [scope, setScope] = useState<MarkupScope>(editing?.scope ?? "org");
  const [targetId, setTargetId] = useState(editing?.targetId ?? "");
  const [modelMode, setModelMode] = useState<MarkupModelMode>(modelModeOf(editing?.model ?? ""));
  const [model, setModel] = useState(editing && !isModelPattern(editing.model) ? editing.model : "");
  const [pattern, setPattern] = useState(editing && isModelPattern(editing.model) ? editing.model : "");
  const [kind, setKind] = useState<MarkupKind>(editing && editing.percent < 0 ? "discount" : "markup");
  const [amount, setAmount] = useState(editing ? Math.abs(editing.percent) / 100 : 0.15);
  const [note, setNote] = useState(editing?.note ?? "");
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "create";

  const orgAlias = (id: string) => orgs.find((org) => org.id === id)?.alias ?? "";
  const targets: PickerItem[] =
    scope === "org"
      ? orgs.map((org) => ({ id: org.id, label: org.alias }))
      : scope === "team"
        ? teams.map((team) => ({ id: team.id, label: team.alias, detail: orgAlias(team.orgId) }))
        : scope === "project"
          ? projects.map((project) => ({
              id: project.id,
              label: project.alias,
              detail: format.list(
                [orgAlias(project.orgId), teams.find((team) => team.id === project.teamId)?.alias ?? ""].filter(
                  Boolean,
                ),
                { type: "unit" },
              ),
            }))
          : [];
  const modelItems: PickerItem[] = [...new Set([...models, ...(model ? [model] : [])])].map((alias) => ({
    id: alias,
    label: alias,
  }));

  const maxAmount = (kind === "discount" ? -MIN_MARKUP_PERCENT : MAX_MARKUP_PERCENT) / 100;
  const amountValid = Number.isFinite(amount) && amount >= 0 && amount <= maxAmount;
  const percent = Math.round((kind === "discount" ? -amount : amount) * 1_000_000) / 10_000;
  const chosenModel = modelMode === "all" ? "" : modelMode === "one" ? model : pattern.trim();
  const targetValid = scope === "all" || Boolean(targetId);
  const modelValid = modelMode === "all" || Boolean(chosenModel);
  const patternInvalid = modelMode === "pattern" && Boolean(pattern.trim()) && !isModelPattern(pattern);
  const valid = targetValid && modelValid && amountValid && !patternInvalid;
  const sale = applyMarkup(EXAMPLE_PURCHASE, amountValid ? percent : 0);
  const share = marginShare(EXAMPLE_PURCHASE, sale);

  function changeScope(next: MarkupScope) {
    setScope(next);
    setTargetId("");
  }

  function save(close: () => void) {
    start(async () => {
      const result = await saveMarkupAction({
        id: editing?.id ?? "",
        scope,
        targetId: scope === "all" ? "" : targetId,
        model: chosenModel,
        percent,
        note,
      });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.markup);
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
                  <Modal.Heading>{t("dialog.title", { mode })}</Modal.Heading>
                  <p className="text-sm text-muted">{t("dialog.hint")}</p>
                </Modal.Header>
                <Modal.Body className="max-h-[70vh] space-y-5 overflow-y-auto">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      selectedKey={scope}
                      onSelectionChange={(key) => {
                        const next = MARKUP_SCOPES.find((item) => item === key);
                        if (next) changeScope(next);
                      }}
                      isDisabled={pending}
                      fullWidth
                    >
                      <Label>{t("dialog.scope")}</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={t("dialog.scope")}>
                          {MARKUP_SCOPES.map((item) => (
                            <ListBox.Item key={item} id={item} textValue={t("scope", { scope: item })}>
                              {t("scope", { scope: item })}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    {scope === "all" ? (
                      <div className="flex items-end">
                        <p className="text-sm text-muted">{t("dialog.allHint")}</p>
                      </div>
                    ) : (
                      <SearchSelect
                        key={scope}
                        label={t("dialog.target", { scope })}
                        placeholder={t("dialog.targetPlaceholder")}
                        items={targets}
                        value={targetId}
                        onChange={setTargetId}
                        isDisabled={pending}
                        isRequired
                      />
                    )}
                  </div>

                  <div className="space-y-3">
                    <p id={modelModeLabel} className="text-sm font-medium">
                      {t("dialog.models")}
                    </p>
                    <ToggleButtonGroup
                      fullWidth
                      selectionMode="single"
                      disallowEmptySelection
                      aria-labelledby={modelModeLabel}
                      selectedKeys={[modelMode]}
                      onSelectionChange={(keys) => {
                        const next = MODEL_MODES.find((item) => keys.has(item));
                        if (next) setModelMode(next);
                      }}
                      isDisabled={pending}
                    >
                      {MODEL_MODES.map((item, index) => (
                        <ToggleButton key={item} id={item}>
                          {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                          {t("dialog.modelMode", { mode: item })}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    {modelMode === "one" ? (
                      <SearchSelect
                        label={t("dialog.model")}
                        placeholder={t("dialog.modelPlaceholder")}
                        items={modelItems}
                        value={model}
                        onChange={setModel}
                        isDisabled={pending}
                        isRequired
                      />
                    ) : null}
                    {modelMode === "pattern" ? (
                      <TextField
                        fullWidth
                        isRequired
                        value={pattern}
                        onChange={setPattern}
                        isInvalid={patternInvalid}
                        isDisabled={pending}
                      >
                        <Label>{t("dialog.pattern")}</Label>
                        <Input placeholder="claude-*" />
                        {patternInvalid ? (
                          <FieldError>{t("dialog.patternInvalid")}</FieldError>
                        ) : (
                          <Description>{t("dialog.patternHint")}</Description>
                        )}
                      </TextField>
                    ) : null}
                    {modelMode === "all" ? <p className="text-sm text-muted">{t("dialog.allModelsHint")}</p> : null}
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <p id={kindLabel} className="text-sm font-medium">
                      {t("dialog.kind")}
                    </p>
                    <ToggleButtonGroup
                      fullWidth
                      selectionMode="single"
                      disallowEmptySelection
                      aria-labelledby={kindLabel}
                      selectedKeys={[kind]}
                      onSelectionChange={(keys) => {
                        const next = KINDS.find((item) => keys.has(item));
                        if (next) setKind(next);
                      }}
                      isDisabled={pending}
                    >
                      {KINDS.map((item, index) => (
                        <ToggleButton key={item} id={item}>
                          {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                          {t("kind", { kind: item })}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    <NumberField
                      fullWidth
                      value={amount}
                      onChange={setAmount}
                      minValue={0}
                      maxValue={maxAmount}
                      step={0.005}
                      formatOptions={formats.number.percent}
                      isInvalid={!amountValid}
                      isDisabled={pending}
                    >
                      <Label>{t("dialog.percent")}</Label>
                      <NumberField.Group>
                        <NumberField.DecrementButton />
                        <NumberField.Input />
                        <NumberField.IncrementButton />
                      </NumberField.Group>
                      {amountValid ? (
                        <Description>{t("dialog.percentHint", { kind })}</Description>
                      ) : (
                        <FieldError>{t("dialog.percentInvalid", { max: maxAmount })}</FieldError>
                      )}
                    </NumberField>
                    <div className="flex flex-wrap gap-2" role="group" aria-label={t("dialog.presets")}>
                      {PRESETS.map((preset) => (
                        <Button
                          key={preset}
                          size="sm"
                          variant={amount === preset ? "secondary" : "tertiary"}
                          isDisabled={pending}
                          onPress={() => setAmount(preset)}
                        >
                          {format.number(preset, "percent")}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <TextField fullWidth value={note} onChange={setNote} isDisabled={pending}>
                    <Label>{t("dialog.note")}</Label>
                    <Input placeholder={t("dialog.notePlaceholder")} maxLength={200} />
                  </TextField>

                  <Card variant="secondary">
                    <Card.Header>
                      <Card.Title>{t("dialog.preview")}</Card.Title>
                      <Card.Description>
                        {t("dialog.previewHint", { purchase: EXAMPLE_PURCHASE })}
                      </Card.Description>
                    </Card.Header>
                    <Card.Content>
                      <dl className="grid grid-cols-3 gap-3">
                        <div>
                          <dt className="text-xs text-muted">{t("metrics.purchase")}</dt>
                          <dd className="text-lg font-semibold tabular-nums">
                            {format.number(EXAMPLE_PURCHASE, "currency")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">{t("metrics.sale")}</dt>
                          <dd className="text-lg font-semibold tabular-nums">{format.number(sale, "currency")}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">{t("metrics.margin")}</dt>
                          <dd
                            className={
                              sale < EXAMPLE_PURCHASE
                                ? "text-lg font-semibold text-warning tabular-nums"
                                : "text-lg font-semibold text-success tabular-nums"
                            }
                          >
                            {format.number(sale - EXAMPLE_PURCHASE, "currency")}
                          </dd>
                          {share === null ? null : (
                            <dd className="text-xs text-muted">{format.number(share, "percent")}</dd>
                          )}
                        </div>
                      </dl>
                    </Card.Content>
                  </Card>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button isPending={pending} isDisabled={!valid} onPress={() => save(close)}>
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("dialog.submit", { mode })}
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
