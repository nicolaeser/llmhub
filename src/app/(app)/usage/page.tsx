"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadUsageTabsAction } from "./_action";
import MarkupsTab from "./_components/markups-tab";
import OverviewTab from "./_components/overview-tab";

export default function UsagePage() {
  const t = useTranslations("Usage");
  const page = useActionData(loadUsageTabsAction);
  const granted = page.data;

  if (!granted) {
    return <PageStatus icon={BarChart3} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const tabs = [
    ...(granted.includes(PERMISSIONS.SPEND_READ)
      ? [{ id: "overview", label: t("tab", { tab: "overview" }), panel: <OverviewTab /> }]
      : []),
    ...(granted.includes(PERMISSIONS.PRICING_READ)
      ? [{ id: "markups", label: t("tab", { tab: "markups" }), panel: <MarkupsTab /> }]
      : []),
  ];

  return (
    <div>
      <PageHeader icon={BarChart3} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
