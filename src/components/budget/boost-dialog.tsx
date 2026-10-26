"use client";

import { useId, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  FieldError,
  Label,
  NumberField,
  Spinner,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type { BoostInput, BudgetResult, BudgetTarget, BudgetView } from "@/types/structure";
import { useErrorToast } from "@/components/console/use-error-toast";
import FormDialog from "@/components/console/form-dialog";

const PRESETS = [10, 25, 50, 100];
const DURATIONS = [
  { id: "24", hours: 24 },
  { id: "72", hours: 72 },
  { id: "168", hours: 168 },
  { id: "720", hours: 720 },
] as const;

export default function BoostDialog({
  state,
  target,
  budget,
  onSubmit,
  onRemove,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  target: BudgetTarget | null;
  budget: BudgetView | null;
  onSubmit: (input: BoostInput) => Promise<BudgetResult | ActionFail>;
  onRemove: (boostId: string) => Promise<BudgetResult | ActionFail>;
  onSaved: (result: BudgetResult) => void;
}) {
  const t = useTranslations("Budgets.boost");
  const showError = useErrorToast();
  const format = useFormatter();
  const now = useClock(60_000);
  const durationLabel = useId();
  const [amount, setAmount] = useState(25);
  const [hours, setHours] = useState(24);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [, startRemove] = useTransition();
  const valid = Number.isFinite(amount) && amount > 0;
  const until = new Date(now.getTime() + hours * 3_600_000);

  function add(close: () => void) {
    if (!target) return;
    start(async () => {
      const result = await onSubmit({ kind: target.kind, id: target.id, amount, hours });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("added"), { variant: "success" });
      close();
    });
  }

  function remove(id: string) {
    setRemoving(id);
    startRemove(async () => {
      const result = await onRemove(id);
      setRemoving(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("removed"), { variant: "success" });
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("title", { alias: target?.alias ?? "" })}
      description={t("hint")}
      submitLabel={t("submit")}
      pending={pending}
      isSubmitDisabled={!target || !valid || removing !== null}
      onSubmit={add}
    >
      <div className="space-y-3">
        <NumberField
          fullWidth
          value={amount}
          onChange={setAmount}
          minValue={0}
          formatOptions={formats.number.currency}
          isInvalid={!valid}
          isDisabled={pending}
        >
          <Label>{t("amount")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          {valid ? (
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

      <div className="space-y-2">
        <p id={durationLabel} className="text-sm font-medium">
          {t("duration")}
        </p>
        <ToggleButtonGroup
          fullWidth
          selectionMode="single"
          disallowEmptySelection
          aria-labelledby={durationLabel}
          selectedKeys={[String(hours)]}
          onSelectionChange={(keys) => {
            const next = DURATIONS.find((item) => item.id === [...keys][0]);
            if (next) setHours(next.hours);
          }}
          isDisabled={pending}
        >
          {DURATIONS.map((item, index) => (
            <ToggleButton key={item.id} id={item.id}>
              {index > 0 ? <ToggleButtonGroup.Separator /> : null}
              {t("hours", { hours: item.hours })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <p className="text-xs text-muted">{t("until", { date: until })}</p>
      </div>

      {budget?.boosts.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("active")}</p>
          <ul className="space-y-2">
            {budget.boosts.map((boost) => (
              <li key={boost.id}>
                <Card
                  variant="secondary"
                  className="flex-row items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium tabular-nums">
                      {format.number(boost.amount, "currency")}
                    </p>
                    <p className="text-xs text-muted">
                      {t("expires", { date: new Date(boost.until) })}
                    </p>
                  </div>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="danger-soft"
                    aria-label={t("remove")}
                    isPending={removing === boost.id}
                    isDisabled={pending || (removing !== null && removing !== boost.id)}
                    onPress={() => remove(boost.id)}
                  >
                    {({ isPending }) =>
                      isPending ? (
                        <Spinner color="current" size="sm" />
                      ) : (
                        <Trash2 size={14} aria-hidden />
                      )
                    }
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </FormDialog>
  );
}
