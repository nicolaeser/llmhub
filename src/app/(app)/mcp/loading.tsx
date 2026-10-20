"use client";

import { Blocks } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function McpLoading() {
  const t = useTranslations("Mcp");
  return <PageLoading icon={Blocks} title={t("title")} subtitle={t("subtitle")} stats={4} layout="cards" />;
}
