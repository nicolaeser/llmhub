"use client";

import { User } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";

export default function UsersLoading() {
  const t = useTranslations("Users");
  return <PageLoading icon={User} title={t("title")} subtitle={t("subtitle")} tabs />;
}
