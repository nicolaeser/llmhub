"use client";

import type { ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";

export default function FormActions({
  label,
  pending,
  isDisabled,
  onSave,
  extra,
}: {
  label: ReactNode;
  pending: boolean;
  isDisabled?: boolean;
  onSave: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 py-3 backdrop-blur-sm">
      {extra}
      <Button isPending={pending} isDisabled={isDisabled} onPress={onSave}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : null}
            {label}
          </>
        )}
      </Button>
    </div>
  );
}
