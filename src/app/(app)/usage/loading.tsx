"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useConsoleScope } from "../_components/console-scope";

export default function UsageLoading() {
  const t = useTranslations("Usage");
  const { kind } = useConsoleScope();
  return (
    <PageLoading
      icon={BarChart3}
      title={t("title")}
      subtitle={t("subtitle", { scope: kind })}
      tabs={kind === "platform"}
      layout="charts"
    />
  );
}
