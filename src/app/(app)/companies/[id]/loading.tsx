"use client";

import { useParams } from "next/navigation";
import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { companyAlias } from "@/lib/tenancy/company-view";
import { useConsoleScope } from "../../_components/console-scope";

export default function CompanyLoading() {
  const t = useTranslations("Companies");
  const params = useParams<{ id: string }>();
  const scope = useConsoleScope();
  const alias = scope.scope.kind === "platform" ? companyAlias(scope, params.id ?? "") : undefined;
  if (!alias) return <PageLoading header tabs stats={4} layout="panels" />;
  return (
    <PageLoading
      icon={Building2}
      title={alias}
      back={{ href: "/companies", label: t("detail.back") }}
      tabs
      stats={4}
      layout="panels"
    />
  );
}
