"use client";

import { Library } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function KnowledgeLoading() {
  const t = useTranslations("Knowledge");
  return <PageLoading icon={Library} title={t("title")} subtitle={t("subtitle")} />;
}
