"use client";

import { Code2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function DeveloperLoading() {
  const t = useTranslations("Developer");
  return <PageLoading icon={Code2} title={t("title")} subtitle={t("subtitle")} tabs layout="chat" />;
}
