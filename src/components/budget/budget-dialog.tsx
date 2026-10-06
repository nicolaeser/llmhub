"use client";

import { useId, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  FieldError,
  Label,
  Meter,
  Modal,
  NumberField,
  Spinner,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { budgetPeriod, capConflict, meterColor } from "@/lib/utils/budget";
import type { ActionFail } from "@/types/actions";
import type {
  BudgetInput,
  BudgetResult,
  BudgetTarget,
  BudgetView,
  CapLink,
} from "@/types/structure";

const PRESETS = [10, 50, 100, 500, 1000];

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
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const current = budget?.maxBudget ?? 0;
  const [limited, setLimited] = useState(current > 0);
  const [amount, setAmount] = useState(current > 0 ? current : 100);
  const [period, setPeriod] = useState(budgetPeriod(budget?.budgetDuration ?? "") ?? "");
  const [pending, start] = useTransition();
  const periodLabel = useId();
  const valid = Number.isFinite(amount) && amount > 0;
  const cap = limited && valid ? amount : 0;
  const conflict = capConflict(cap, ancestors);
  const spend = budget?.spend ?? 0;
  const ratio = cap > 0 ? Math.min(1, spend / cap) : 0;
  const custom = PERIODS.some((item) => item.value === period) ? null : period;

  function save(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await onSubmit({
        kind: target.kind,
        id: target.id,
        maxBudget: cap,
        budgetDuration: period,
      });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("toasts.saved"), { variant: "success" });
      close();
    });
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-lg">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("title", { alias: target?.alias ?? "" })}</Modal.Heading>
                  <p className="text-sm text-muted">
                    {t("kindHint", { kind: target?.kind ?? "org" })}
                  </p>
                </Modal.Header>
                <Modal.Body className="space-y-5">
                  <Switch isSelected={limited} onChange={setLimited} isDisabled={pending}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("limitSpend")}</Label>
                    </Switch.Content>
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
                    </div>
                  ) : (
                    <p className="text-sm text-muted">{t("unlimitedHint")}</p>
                  )}

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
                    </Card.Content>
                  </Card>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!target || Boolean(conflict) || (limited && !valid)}
                    onPress={() => save(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("saveBudget")}
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
