"use client";

import { use, useEffect } from "react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useRouter } from "@/i18n/routing";
import { useConsoleScope } from "../../_components/console-scope";
import CompanyDetail from "../_components/company-detail";

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Companies");
  const router = useRouter();
  const { scope } = useConsoleScope();
  const companyScope = scope.kind === "company";

  useEffect(() => {
    if (companyScope) router.replace("/companies");
  }, [companyScope, router]);

  if (companyScope) return <PageLoading header tabs stats={4} layout="panels" />;
  return <CompanyDetail key={id} orgId={id} back={{ href: "/companies", label: t("detail.back") }} />;
}
