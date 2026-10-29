"use client";

import { Alert, Checkbox } from "@heroui/react";
import { useTranslations } from "next-intl";

export default function ShareNotice({
  instance,
  manageable,
  accepted,
  onAcceptedChange,
}: {
  instance: string;
  manageable: boolean;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}) {
  const t = useTranslations("SubAdd.notice");
  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content className="min-w-0 space-y-3">
        <Alert.Title>{t("title")}</Alert.Title>
        <ul className="list-disc space-y-1 pl-4 text-sm">
          <li>{t("usage", { named: instance ? "true" : "false", instance })}</li>
          <li>{t("tokens")}</li>
          <li>{t("terms")}</li>
          <li>{t("withdraw", { manageable: String(manageable) })}</li>
        </ul>
        <Checkbox isSelected={accepted} onChange={onAcceptedChange}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span className="text-sm font-medium">{t("accept")}</span>
          </Checkbox.Content>
        </Checkbox>
      </Alert.Content>
    </Alert>
  );
}
