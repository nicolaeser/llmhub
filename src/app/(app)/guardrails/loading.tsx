"use client";

import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function GuardrailsLoading() {
  const t = useTranslations("Guardrails");
  return <PageLoading icon={Shield} title={t("title")} subtitle={t("subtitle")} tabs stats={3} layout="form" />;
}
