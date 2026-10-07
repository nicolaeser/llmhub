"use client";

import { useId, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  FieldError,
  Label,
  Modal,
  NumberField,
  Spinner,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import type { BudgetResult, BudgetTarget, BudgetView } from "@/types/structure";
import { addBoostAction, removeBoostAction } from "../_action";

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
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  target: BudgetTarget | null;
  budget: BudgetView | null;
  onSaved: (result: BudgetResult) => void;
}) {
  const t = useTranslations("Companies.boost");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
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
      const result = await addBoostAction({ kind: target.kind, id: target.id, amount, hours });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
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
      const result = await removeBoostAction(id);
      setRemoving(null);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result);
      toast(t("removed"), { variant: "success" });
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
                  <p className="text-sm text-muted">{t("hint")}</p>
                </Modal.Header>
                <Modal.Body className="space-y-5">
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
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    isPending={pending}
                    isDisabled={!target || !valid || removing !== null}
                    onPress={() => add(close)}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : null}
                        {t("submit")}
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
