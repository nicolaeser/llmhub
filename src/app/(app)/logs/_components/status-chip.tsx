import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";

export default function StatusChip({ status, outcome }: { status: number; outcome: string }) {
  const t = useTranslations("Logs");
  return (
    <Chip
      size="sm"
      variant="soft"
      color={status >= 500 ? "danger" : status >= 400 ? "warning" : "success"}
      className="whitespace-nowrap"
    >
      {t("statusOutcome", { status, outcome })}
    </Chip>
  );
}
