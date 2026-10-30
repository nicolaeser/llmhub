"use client";

import { CircleUser } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function AccountLoading() {
  const t = useTranslations("Account");
  return <PageLoading icon={CircleUser} title={t("title")} subtitle={t("subtitle")} layout="columns" tabs />;
}
