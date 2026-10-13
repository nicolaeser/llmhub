"use client";

import { useId, type ReactNode } from "react";
import { Button, Form, Modal, Spinner, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";

const WIDTHS = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
} as const;

export type FormDialogSize = keyof typeof WIDTHS;

export default function FormDialog({
  state,
  title,
  description,
  size = "md",
  submitLabel,
  submitIcon,
  submitVariant = "primary",
  pending = false,
  isSubmitDisabled = false,
  onSubmit,
  children,
}: {
  state: ReturnType<typeof useOverlayState>;
  title: ReactNode;
  description?: ReactNode;
  size?: FormDialogSize;
  submitLabel: ReactNode;
  submitIcon?: ReactNode;
  submitVariant?: "primary" | "danger";
  pending?: boolean;
  isSubmitDisabled?: boolean;
  onSubmit: (close: () => void) => void;
  children: ReactNode;
}) {
  const t = useTranslations("Common");
  const formId = useId();

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className={WIDTHS[size]}>
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{title}</Modal.Heading>
                  {description ? <p className="text-sm text-muted">{description}</p> : null}
                </Modal.Header>
                <Modal.Body>
                  <Form
                    id={formId}
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!pending && !isSubmitDisabled) onSubmit(close);
                    }}
                  >
                    {children}
                  </Form>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {t("cancel")}
                  </Button>
                  <Button
                    type="submit"
                    form={formId}
                    variant={submitVariant}
                    isPending={pending}
                    isDisabled={isSubmitDisabled}
                  >
                    {({ isPending }) => (
                      <>
                        {isPending ? <Spinner color="current" size="sm" /> : submitIcon}
                        {submitLabel}
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
