"use client";

import { Alert, Button, Label, Modal, RadioGroup, Spinner } from "@heroui/react";
import { Check, TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import { FORM_DIALOG_WIDTHS } from "@/components/console/form-dialog";
import type { ResetCredits, ResetOption } from "@/types/resets";
import ResetOptionCard from "./reset-option-card";
import ResetReview from "./reset-review";
import { isSpendable } from "./reset-view";
import { useResetLabels } from "./use-reset-labels";

const STEP_DOT = "grid size-5 place-items-center rounded-full text-xs font-semibold tabular-nums";

export default function ResetDialog({
  isOpen,
  name,
  credits,
  options,
  selected,
  reviewing,
  stale,
  timeZone,
  pending,
  onSelect,
  onContinue,
  onBack,
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  name: string;
  credits: ResetCredits;
  options: ResetOption[];
  selected: ResetOption | null;
  reviewing: ResetOption | null;
  stale: boolean;
  timeZone: string;
  pending: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
  onConfirm: (option: ResetOption) => void;
  onClose: () => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  const tCommon = useTranslations("Common");
  const labels = useResetLabels(timeZone, credits);
  const stepped = options.length > 1 || reviewing === null;
  const steps = [
    { id: "choose", title: t("flow.chooseStep"), active: reviewing === null, done: reviewing !== null },
    { id: "review", title: t("flow.reviewStep"), active: reviewing !== null, done: false },
  ];

  return (
    <Modal.Backdrop
      variant="blur"
      isOpen={isOpen}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container>
        <Modal.Dialog className={FORM_DIALOG_WIDTHS.lg}>
          <Modal.Header className="gap-4">
            <div className="space-y-1">
              <Modal.Heading>{reviewing ? t("flow.reviewStep") : t("flow.chooseStep")}</Modal.Heading>
              <p className="break-words text-sm text-muted">{t("flow.account", { name })}</p>
            </div>
            {stepped ? (
              <ol className="flex flex-wrap items-center gap-1.5" aria-label={tCommon("steps.label")}>
                {steps.map((step, position) => (
                  <li key={step.id} className="flex items-center gap-1.5">
                    {position > 0 ? <span className="hidden h-px w-4 bg-separator sm:block" aria-hidden /> : null}
                    <Button
                      size="sm"
                      variant={step.active ? "secondary" : "ghost"}
                      aria-current={step.active ? "step" : undefined}
                      isDisabled={pending || (step.id === "review" && selected === null)}
                      onPress={step.id === "choose" ? onBack : onContinue}
                    >
                      <span
                        className={`${STEP_DOT} ${
                          step.active
                            ? "bg-accent text-accent-foreground"
                            : step.done
                              ? "bg-accent/14 text-accent"
                              : "bg-foreground/8 text-muted"
                        }`}
                        aria-hidden
                      >
                        {step.done ? <Check size={12} /> : position + 1}
                      </span>
                      <span className={step.active ? "text-foreground" : "text-muted"}>{step.title}</span>
                    </Button>
                  </li>
                ))}
              </ol>
            ) : null}
          </Modal.Header>
          <Modal.Body>
            {reviewing ? (
              <ResetReview option={reviewing} credits={credits} labels={labels} />
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted">{t("flow.chooseHint")}</p>
                {stale ? (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content className="min-w-0">
                      <Alert.Title>{t("flow.changed")}</Alert.Title>
                    </Alert.Content>
                  </Alert>
                ) : null}
                {options.some(isSpendable) ? null : (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content className="min-w-0">
                      <Alert.Title>{t("flow.noneUsable")}</Alert.Title>
                    </Alert.Content>
                  </Alert>
                )}
                <RadioGroup value={selected?.id ?? null} onChange={onSelect} isDisabled={pending} className="gap-2">
                  <Label>{t("flow.chooseLabel")}</Label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {options.map((option) => (
                      <ResetOptionCard
                        key={option.id}
                        option={option}
                        selected={option.id === selected?.id}
                        labels={labels}
                        autoFocus={option.id === selected?.id}
                      />
                    ))}
                  </div>
                </RadioGroup>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="flex-wrap justify-between gap-2">
            <p className="text-xs text-muted tabular-nums">
              {stepped ? tCommon("steps.progress", { current: reviewing ? 2 : 1, total: 2 }) : null}
            </p>
            {reviewing ? (
              <div key="review" className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="tertiary" autoFocus isDisabled={pending} onPress={options.length > 1 ? onBack : onClose}>
                  {options.length > 1 ? tCommon("back") : tCommon("cancel")}
                </Button>
                <Button isPending={pending} isDisabled={!isSpendable(reviewing)} onPress={() => onConfirm(reviewing)}>
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : <TimerReset size={16} aria-hidden />}
                      {labels.confirm(reviewing)}
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div key="choose" className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="tertiary" onPress={onClose}>
                  {tCommon("cancel")}
                </Button>
                <Button isDisabled={selected === null} onPress={onContinue}>
                  {tCommon("continue")}
                </Button>
              </div>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
