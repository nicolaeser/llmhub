"use client";

import { Network } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function ModelsLoading() {
  const t = useTranslations("Models");
  return <PageLoading icon={Network} title={t("title")} subtitle={t("subtitle")} tabs stats={3} layout="panels" />;
}
