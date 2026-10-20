"use client";

import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useConsoleScope } from "../_components/console-scope";

export default function CompaniesLoading() {
  const t = useTranslations("Companies");
  const { scope } = useConsoleScope();
  return <PageLoading icon={Building2} title={scope.kind === "company" ? scope.alias : t("title")} layout="split" />;
}
