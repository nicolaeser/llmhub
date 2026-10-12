"use client";

import { useState } from "react";
import { Button, toast } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";

const COPIED_MS = 2000;

export default function CopyButton({
  text,
  label,
  variant = "ghost",
  showLabel = false,
}: {
  text: string;
  label: string;
  variant?: "ghost" | "secondary";
  showLabel?: boolean;
}) {
  const t = useTranslations("Common");
  const [copied, setCopied] = useState(false);
  const Icon = copied ? Check : Copy;

  return (
    <Button
      isIconOnly={!showLabel}
      size="sm"
      variant={variant}
      aria-label={showLabel ? undefined : label}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast(t("copied"), { variant: "success" });
          window.setTimeout(() => setCopied(false), COPIED_MS);
        } catch {
          toast.danger(t("copyFailed"));
        }
      }}
    >
      <Icon size={14} aria-hidden />
      {showLabel ? (copied ? t("copied") : label) : null}
    </Button>
  );
}
