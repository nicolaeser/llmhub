"use client";

import { Button } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Error.boundary");
  return (
    <div role="alert" className="flex flex-col items-center gap-4 py-20 text-center">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="max-w-md text-sm text-muted">{t("description")}</p>
      {error.digest ? (
        <p className="text-xs text-muted">{t("errorId", { id: error.digest })}</p>
      ) : null}
      <Button aria-label={t("tryAgainAria")} onPress={reset}>
        <RotateCcw size={14} aria-hidden />
        {t("tryAgain")}
      </Button>
    </div>
  );
}
