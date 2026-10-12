"use client";

import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { Alert, Button, Card, Checkbox } from "@heroui/react";
import { Download } from "lucide-react";

export function RecoveryCodesPanel({
  codes,
  acknowledged,
  onAcknowledgedChange,
}: {
  codes: string[];
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
}) {
  const t = useTranslations("Security");
  const text = codes.join("\n");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content className="min-w-0">
          <Alert.Title>{t("recoveryTitle")}</Alert.Title>
          <Alert.Description>{t("recoveryIntro")}</Alert.Description>
        </Alert.Content>
      </Alert>
      <Card variant="secondary">
        <ol
          aria-label={t("recoveryListLabel")}
          className="grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2"
        >
          {codes.map((code) => (
            <li key={code} className="break-all tabular-nums">
              {code}
            </li>
          ))}
        </ol>
      </Card>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} label={t("copyAll")} variant="secondary" showLabel />
        <Button
          size="sm"
          variant="secondary"
          onPress={() => {
            const url = URL.createObjectURL(
              new Blob([`${t("recoveryFileHeader")}\n\n${text}\n`], { type: "text/plain" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "llmhub-recovery-codes.txt";
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={14} aria-hidden />
          {t("download")}
        </Button>
      </div>
      <Checkbox isSelected={acknowledged} onChange={onAcknowledgedChange}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span className="min-w-0 text-sm">{t("storedConfirm")}</span>
        </Checkbox.Content>
      </Checkbox>
    </div>
  );
}
