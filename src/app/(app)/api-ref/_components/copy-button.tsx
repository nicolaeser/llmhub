"use client";

import { Button, toast } from "@heroui/react";

export default function CopyButton({
  value,
  id,
  copied,
  copyLabel,
  copiedLabel,
  onCopied,
}: {
  value: string;
  id: string;
  copied: string | null;
  copyLabel: string;
  copiedLabel: string;
  onCopied: (id: string) => void;
}) {
  const isCopied = copied === id;
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={isCopied ? copiedLabel : copyLabel}
      onPress={() => {
        void navigator.clipboard.writeText(value).then(() => {
          onCopied(id);
          toast(copiedLabel, { variant: "success" });
        });
      }}
    >
      {isCopied ? copiedLabel : copyLabel}
    </Button>
  );
}
