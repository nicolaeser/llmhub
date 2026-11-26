"use client";

import { useId, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  FieldError,
  Label,
  Meter,
  NumberField,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { budgetPeriod, capConflict, MAX_OVERRUN_PCT, meterColor, overrunPercent } from "@/lib/utils/budget";
import type { ActionFail } from "@/types/actions";
import type {
  BudgetInput,
  BudgetMode,
  BudgetResult,
  BudgetTarget,
  BudgetView,
  CapLink,
} from "@/types/structure";
import { useErrorToast } from "@/components/console/use-error-toast";
import FormDialog from "@/components/console/form-dialog";
import ChoiceCards from "@/components/console/choice-cards";

const PRESETS = [10, 50, 100, 500, 1000];
const MODES: readonly BudgetMode[] = ["soft", "hard"];
const DEFAULT_OVERRUN_PCT = 10;

const PERIODS = [
  { id: "none", value: "", label: "none" },
  { id: "1d", value: "1d", label: "daily" },
  { id: "7d", value: "7d", label: "weekly" },
  { id: "30d", value: "30d", label: "monthly" },
] as const;

export default function BudgetDialog({
  state,
  target,
  budget,
  ancestors,
  onSubmit,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  target: BudgetTarget | null;
  budget: BudgetView | null;
  ancestors: CapLink[];
  onSubmit: (input: BudgetInput) => Promise<BudgetResult | ActionFail>;
  onSaved: (result: BudgetResult) => void;
}) {
  const t = useTranslations("Budgets");
  const showError = useErrorToast();
  const format = useFormatter();
  const now = useClock(60_000);
  const current = budget?.maxBudget ?? 0;
  const savedPeriod = budgetPeriod(budget?.budgetDuration ?? "") ?? "";
  const [limited, setLimited] = useState(current > 0);
  const [amount, setAmount] = useState(current > 0 ? current : 100);
  const [period, setPeriod] = useState(savedPeriod);
  const [mode, setMode] = useState<BudgetMode>(budget?.budgetMode ?? "soft");
  const [overrunCapped, setOverrunCapped] = useState(budget?.overrunPct != null);
  const [overrun, setOverrun] = useState(budget?.overrunPct ?? DEFAULT_OVERRUN_PCT);
  const [pending, start] = useTransition();
  const periodLabel = useId();
  const valid = Number.isFinite(amount) && amount > 0;
  const cap = limited && valid ? amount : 0;
  const conflict = capConflict(cap, ancestors);
  const spend = budget?.spend ?? 0;
  const ratio = cap > 0 ? Math.min(1, spend / cap) : 0;
  const custom = PERIODS.some((item) => item.value === period) ? null : period;
  const resetsAt = budget?.resetsAt && period === savedPeriod ? new Date(budget.resetsAt) : null;
  const overrunValid = overrunPercent(overrun) != null;
  const overrunPct = mode === "soft" && overrunCapped ? overrun : null;

  function save(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await onSubmit({
        kind: target.kind,
        id: target.id,
        maxBudget: cap,
        budgetDuration: period,
        budgetMode: mode,
        overrunPct,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("toasts.saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("title", { alias: target?.alias ?? "" })}
      description={t("kindHint", { kind: target?.kind ?? "org" })}
      submitLabel={t("saveBudget")}
      pending={pending}
      isSubmitDisabled={
        !target || Boolean(conflict) || (limited && !valid) || (limited && overrunPct !== null && !overrunValid)
      }
      onSubmit={save}
    >
      <Card variant="secondary">
        <Card.Content className="space-y-3">
          {cap > 0 ? (
            <Meter
              value={ratio * 100}
              color={meterColor(ratio)}
              size="sm"
              aria-label={t("preview")}
            >
              <Label>{t("preview")}</Label>
              <Meter.Output />
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
          ) : null}
          <p className="text-sm text-muted">
            {t("previewText", {
              spend,
              capped: cap > 0 ? "yes" : "no",
              cap,
              boost: budget?.boost ?? 0,
              hasBoost: (budget?.boost ?? 0) > 0 ? "yes" : "no",
            })}
          </p>
          {resetsAt ? (
            <p className="text-sm text-muted">
              {t("resets", { when: resetsAt > now ? "later" : "now", date: resetsAt })}
            </p>
          ) : null}
        </Card.Content>
      </Card>

      <Switch isSelected={limited} onChange={setLimited} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("limitSpend")}</Label>
        </Switch.Content>
        <Description>{t("limitSpendHint")}</Description>
      </Switch>

      {limited ? (
        <div className="space-y-3">
          <NumberField
            fullWidth
            value={amount}
            onChange={setAmount}
            minValue={0}
            formatOptions={formats.number.currency}
            isInvalid={Boolean(conflict) || !valid}
            isDisabled={pending}
          >
            <Label>{t("amount")}</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            {conflict ? (
              <FieldError>
                {t("exceedsParent", {
                  kind: conflict.kind,
                  alias: conflict.alias,
                  cap: conflict.cap,
                })}
              </FieldError>
            ) : valid ? (
              <Description>{t("amountHint")}</Description>
            ) : (
              <FieldError>{t("amountInvalid")}</FieldError>
            )}
          </NumberField>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("presets")}>
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                size="sm"
                variant={amount === preset ? "secondary" : "tertiary"}
                isDisabled={pending}
                onPress={() => setAmount(preset)}
              >
                {format.number(preset, "currencyWhole")}
              </Button>
            ))}
          </div>
          <ChoiceCards
            label={t("mode")}
            value={mode}
            columns={2}
            isDisabled={pending}
            onChange={setMode}
            options={MODES.map((id) => ({ id, label: t("modes", { mode: id }), hint: t("modeHints", { mode: id }) }))}
          />
          {mode === "soft" ? (
            <div className="space-y-3">
              <Switch isSelected={overrunCapped} onChange={setOverrunCapped} isDisabled={pending}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t("capOverrun")}</Label>
                </Switch.Content>
                <Description>{t("capOverrunHint")}</Description>
              </Switch>
              {overrunCapped ? (
                <NumberField
                  fullWidth
                  value={overrun}
                  onChange={setOverrun}
                  minValue={1}
                  maxValue={MAX_OVERRUN_PCT}
                  formatOptions={formats.number.percentPoints}
                  isInvalid={!overrunValid}
                  isDisabled={pending}
                >
                  <Label>{t("overrun")}</Label>
                  <NumberField.Group>
                    <NumberField.DecrementButton />
                    <NumberField.Input />
                    <NumberField.IncrementButton />
                  </NumberField.Group>
                  {overrunValid ? (
                    <Description>{t("overrunHint", { ceiling: cap * (1 + overrun / 100) })}</Description>
                  ) : (
                    <FieldError>{t("overrunInvalid", { max: MAX_OVERRUN_PCT })}</FieldError>
                  )}
                </NumberField>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <p id={periodLabel} className="text-sm font-medium">
          {t("period")}
        </p>
        <ToggleButtonGroup
          fullWidth
          selectionMode="single"
          disallowEmptySelection
          aria-labelledby={periodLabel}
          selectedKeys={[custom ?? PERIODS.find((item) => item.value === period)?.id ?? "none"]}
          onSelectionChange={(keys) => {
            const id = [...keys][0];
            const next = PERIODS.find((item) => item.id === id);
            if (next) setPeriod(next.value);
          }}
          isDisabled={pending}
        >
          {PERIODS.map((item, index) => (
            <ToggleButton key={item.id} id={item.id}>
              {index > 0 ? <ToggleButtonGroup.Separator /> : null}
              {t("periods", { period: item.label })}
            </ToggleButton>
          ))}
          {custom ? (
            <ToggleButton id={custom}>
              <ToggleButtonGroup.Separator />
              {t("periodCustom", { days: Number.parseInt(custom, 10) })}
            </ToggleButton>
          ) : null}
        </ToggleButtonGroup>
        <p className="text-xs text-muted">{t("periodHint")}</p>
      </div>

    </FormDialog>
  );
}
