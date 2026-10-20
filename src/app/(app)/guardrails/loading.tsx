"use client";

import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useConsoleScope } from "../_components/console-scope";

export default function GuardrailsLoading() {
  const t = useTranslations("Guardrails");
  const { kind } = useConsoleScope();
  return (
    <PageLoading
      icon={Shield}
      title={t("title")}
      subtitle={kind === "company" ? t("companySubtitle") : t("subtitle")}
      tabs
      stats={3}
      layout="form"
    />
  );
}
