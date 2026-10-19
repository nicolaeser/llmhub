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
    <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
      {extra}
      <Button isPending={pending} isDisabled={isDisabled} onPress={onSave} className="w-full sm:w-auto">
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
