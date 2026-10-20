"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useConsoleScope } from "../_components/console-scope";
import { loadUsageTabsAction } from "./_action";
import MarkupsTab from "./_components/markups-tab";
import OverviewTab from "./_components/overview-tab";

export default function UsagePage() {
  const t = useTranslations("Usage");
  const { kind } = useConsoleScope();
  const page = useActionData(loadUsageTabsAction);
  const granted = page.data;
  const subtitle = t("subtitle", { scope: kind });

  if (!granted) {
    return (
      <PageStatus
        icon={BarChart3}
        title={t("title")}
        subtitle={subtitle}
        state={page}
        tabs={kind === "platform"}
        layout="charts"
      />
    );
  }

  const tabs = [
    ...(granted.includes("overview")
      ? [{ id: "overview", label: t("tab", { tab: "overview" }), panel: <OverviewTab /> }]
      : []),
    ...(granted.includes("markups")
      ? [{ id: "markups", label: t("tab", { tab: "markups" }), panel: <MarkupsTab /> }]
      : []),
  ];

  return (
    <div>
      <PageHeader icon={BarChart3} title={t("title")} subtitle={subtitle} />
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
