"use client";

import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function CompaniesLoading() {
  const t = useTranslations("Companies");
  return <PageLoading icon={Building2} title={t("title")} layout="split" />;
}
