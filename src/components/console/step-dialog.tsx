"use client";

import { useId, useState, type ReactNode } from "react";
import { Button, Form, Modal, Spinner, type useOverlayState } from "@heroui/react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { FORM_DIALOG_WIDTHS, type FormDialogSize } from "@/components/console/form-dialog";

export type DialogStep = {
  id: string;
  title: string;
  description?: ReactNode;
  optional?: boolean;
  isValid?: boolean;
  content: ReactNode;
};

export default function StepDialog({
  state,
  title,
  description,
  size = "lg",
  steps,
  submitLabel,
  submitIcon,
  pending = false,
  isSubmitDisabled = false,
  onSubmit,
}: {
  state: ReturnType<typeof useOverlayState>;
  title: ReactNode;
  description?: ReactNode;
  size?: FormDialogSize;
  steps: readonly DialogStep[];
  submitLabel: ReactNode;
  submitIcon?: ReactNode;
  pending?: boolean;
  isSubmitDisabled?: boolean;
  onSubmit: (close: () => void) => void;
}) {
  const t = useTranslations("Common");
  const formId = useId();
  const [index, setIndex] = useState(0);
  const current = Math.min(index, steps.length - 1);
  const step = steps[current];
  const last = current === steps.length - 1;
  const firstInvalid = steps.findIndex((item) => item.isValid === false);
  const reachable = firstInvalid === -1 ? steps.length - 1 : firstInvalid;
  const canFinish = firstInvalid === -1 && !isSubmitDisabled;
  const restOptional = steps.slice(current + 1).every((item) => item.optional);

  function advance(close: () => void) {
    if (pending) return;
    if (last || (restOptional && canFinish)) {
      if (canFinish) onSubmit(close);
      return;
    }
    if (step?.isValid !== false) setIndex(current + 1);
  }

  return (
    <Modal.Backdrop variant="blur" isOpen={state.isOpen} onOpenChange={state.setOpen}>
      <Modal.Container>
        <Modal.Dialog className={FORM_DIALOG_WIDTHS[size]}>
          {({ close }) => (
            <>
              <Modal.Header className="gap-4">
                <div className="space-y-1">
                  <Modal.Heading>{title}</Modal.Heading>
                  {description ? <p className="text-sm text-muted">{description}</p> : null}
                </div>
                <ol className="flex flex-wrap items-center gap-1.5" aria-label={t("steps.label")}>
                  {steps.map((item, position) => {
                    const done = position < current;
                    const active = position === current;
                    return (
                      <li key={item.id} className="flex items-center gap-1.5">
                        {position > 0 ? <span className="h-px w-4 bg-separator" aria-hidden /> : null}
                        <Button
                          size="sm"
                          variant={active ? "secondary" : "ghost"}
                          aria-current={active ? "step" : undefined}
                          isDisabled={pending || position > reachable}
                          onPress={() => setIndex(position)}
                        >
                          <span
                            className={`grid size-5 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                              active
                                ? "bg-accent text-accent-foreground"
                                : done
                                  ? "bg-accent/14 text-accent"
                                  : "bg-foreground/8 text-muted"
                            }`}
                            aria-hidden
                          >
                            {done ? <Check size={12} /> : position + 1}
                          </span>
                          <span className={active ? "text-foreground" : "text-muted"}>{item.title}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              </Modal.Header>
              <Modal.Body>
                <Form
                  id={formId}
                  className="flex flex-col gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    advance(close);
                  }}
                >
                  {step?.description ? <p className="text-sm text-muted">{step.description}</p> : null}
                  {step?.content}
                </Form>
              </Modal.Body>
              <Modal.Footer className="flex-wrap justify-between gap-2">
                <p className="text-xs text-muted tabular-nums">
                  {t("steps.progress", { current: current + 1, total: steps.length })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {current > 0 ? (
                    <Button variant="tertiary" onPress={() => setIndex(current - 1)} isDisabled={pending}>
                      {t("back")}
                    </Button>
                  ) : (
                    <Button variant="tertiary" onPress={close} isDisabled={pending}>
                      {t("cancel")}
                    </Button>
                  )}
                  {!last && restOptional ? (
                    <Button
                      variant="secondary"
                      onPress={() => setIndex(current + 1)}
                      isDisabled={pending || step?.isValid === false}
                    >
                      {t("continue")}
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    form={formId}
                    isPending={pending}
                    isDisabled={last || restOptional ? !canFinish : step?.isValid === false}
                  >
                    {({ isPending }) =>
                      last || restOptional ? (
                        <>
                          {isPending ? <Spinner color="current" size="sm" /> : submitIcon}
                          {submitLabel}
                        </>
                      ) : (
                        t("continue")
                      )
                    }
                  </Button>
                </div>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
