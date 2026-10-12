"use client";

import type { ReactNode } from "react";
import { AlertDialog, Button, type useOverlayState } from "@heroui/react";

export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  pending,
  onConfirm,
  state,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  state?: ReturnType<typeof useOverlayState>;
  children?: ReactNode;
}) {
  return (
    <AlertDialog isOpen={state?.isOpen} onOpenChange={state?.setOpen}>
      {children ? <AlertDialog.Trigger>{children}</AlertDialog.Trigger> : null}
      <AlertDialog.Backdrop variant="blur">
        <AlertDialog.Container>
          <AlertDialog.Dialog className="max-w-md">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            {description ? (
              <AlertDialog.Body>
                <p className="text-sm text-muted">{description}</p>
              </AlertDialog.Body>
            ) : null}
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                {cancelLabel}
              </Button>
              <Button slot="close" variant="danger" isPending={pending} onPress={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
