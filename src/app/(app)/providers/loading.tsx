"use client";

import { Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function ProvidersLoading() {
  const t = useTranslations("Providers");
  return <PageLoading icon={Plug} title={t("title")} subtitle={t("subtitle")} tabs layout="cards" />;
}
