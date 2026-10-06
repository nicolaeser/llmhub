"use client";

import type { ReactNode } from "react";
import { AlertDialog, Button } from "@heroui/react";

export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  pending,
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialog.Trigger>{children}</AlertDialog.Trigger>
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
              <AlertDialog.CloseTrigger>
                <Button variant="tertiary">{cancelLabel}</Button>
              </AlertDialog.CloseTrigger>
              <Button variant="danger" isPending={pending} onPress={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
