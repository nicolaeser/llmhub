"use client";

import { LayoutDashboard } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function OverviewLoading() {
  const t = useTranslations("Overview");
  return <PageLoading icon={LayoutDashboard} title={t("title")} subtitle={t("subtitle")} stats={4} layout="dashboard" />;
}
