"use client";

import { Code2 } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadDeveloperTabsAction } from "./_action";
import ApiTab from "./_components/api-tab";
import PlaygroundTab from "./_components/playground-tab";

export default function DeveloperPage() {
  const t = useTranslations("Developer");
  const page = useActionData(loadDeveloperTabsAction);
  const granted = page.data;

  if (!granted) {
    return <PageStatus icon={Code2} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const tabs = [
    ...(granted.includes(PERMISSIONS.PLAYGROUND_USE)
      ? [{ id: "playground", label: t("tab", { tab: "playground" }), panel: <PlaygroundTab /> }]
      : []),
    ...(granted.includes(PERMISSIONS.KEYS_READ) ? [{ id: "api", label: t("tab", { tab: "api" }), panel: <ApiTab /> }] : []),
  ];

  return (
    <div>
      <PageHeader icon={Code2} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
