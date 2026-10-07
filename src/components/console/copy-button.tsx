"use client";

import { Button, toast } from "@heroui/react";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";

export default function CopyButton({
  text,
  label,
  variant = "ghost",
}: {
  text: string;
  label: string;
  variant?: "ghost" | "secondary";
}) {
  const t = useTranslations("Common");
  return (
    <Button
      isIconOnly
      size="sm"
      variant={variant}
      aria-label={label}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(t("copied"), { variant: "success" });
        } catch {
          toast.danger(t("copyFailed"));
        }
      }}
    >
      <Copy size={14} aria-hidden />
    </Button>
  );
}
