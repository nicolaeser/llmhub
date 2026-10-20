"use client";

import { Alert, Button } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { errorDigest } from "@/lib/utils/error-digest";

export default function SubAddError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("Error.boundary");
  const digest = errorDigest(error);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{t("title")}</h1>
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{t("pageDescription")}</Alert.Title>
          {digest ? <Alert.Description className="break-all">{t("errorId", { id: digest })}</Alert.Description> : null}
        </Alert.Content>
        <Button size="sm" variant="danger-soft" onPress={retry}>
          <RotateCcw size={14} aria-hidden />
          {t("tryAgain")}
        </Button>
      </Alert>
    </div>
  );
}
