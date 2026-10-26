"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function KeysLoading() {
  const t = useTranslations("Keys");
  return <PageLoading icon={KeyRound} title={t("title")} subtitle={t("subtitle")} stats={4} />;
}
