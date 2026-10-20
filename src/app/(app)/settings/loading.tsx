"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function SettingsLoading() {
  const t = useTranslations("Settings");
  return <PageLoading icon={Settings} title={t("title")} tabs layout="form" />;
}
