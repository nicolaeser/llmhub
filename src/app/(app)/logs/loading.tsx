"use client";

import { Activity } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function LogsLoading() {
  const t = useTranslations("Logs");
  return <PageLoading icon={Activity} title={t("title")} subtitle={t("subtitle")} filters={8} tabs layout="rows" />;
}
