"use client";

import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useConsoleScope } from "../_components/console-scope";

export default function CompaniesLoading() {
  const t = useTranslations("Companies");
  const { scope } = useConsoleScope();
  if (scope.kind === "company") {
    return <PageLoading icon={Building2} title={scope.alias} tabs stats={4} layout="panels" />;
  }
  return <PageLoading icon={Building2} title={t("title")} subtitle={t("subtitle")} />;
}
