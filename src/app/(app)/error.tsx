"use client";

import { useEffect } from "react";
import { Button } from "@heroui/react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { reportClientError } from "@/lib/sentry/report-client-error";
import { errorDigest } from "@/lib/utils/error-digest";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("Error.boundary");
  const digest = errorDigest(error);
  useEffect(() => {
    reportClientError(error, { boundary: "app", digest });
  }, [error, digest]);
  return (
    <div role="alert" className="flex flex-col items-center gap-4 py-20 text-center">
      <IconTile icon={TriangleAlert} tone="danger" size="lg" />
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="max-w-md text-sm text-muted">{t("description")}</p>
      {digest ? <p className="text-xs break-all text-muted">{t("errorId", { id: digest })}</p> : null}
      <Button onPress={retry}>
        <RotateCcw size={14} aria-hidden />
        {t("tryAgain")}
      </Button>
    </div>
  );
}
