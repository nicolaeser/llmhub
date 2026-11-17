import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import { requestStatusTone } from "@/lib/gateway/request-logs/request-status";

export default function StatusChip({ status, outcome }: { status: number; outcome: string }) {
  const t = useTranslations("Logs");
  return (
    <Chip
      size="sm"
      variant="soft"
      color={requestStatusTone(status)}
      className="whitespace-nowrap"
    >
      {t("statusOutcome", { status, outcome })}
    </Chip>
  );
}
