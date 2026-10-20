"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function UsageLoading() {
  const t = useTranslations("Usage");
  return <PageLoading icon={BarChart3} title={t("title")} subtitle={t("subtitle")} tabs layout="charts" />;
}
