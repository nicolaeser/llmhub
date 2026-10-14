"use client";

import { Alert } from "@heroui/react";
import { Waypoints } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import StatCard from "@/components/console/stat-card";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadIntegrationsAction } from "./_action";
import AccessPanel from "./_components/access-panel";
import ActivityPanel from "./_components/activity-panel";
import AgentPanel from "./_components/agent-panel";
import CatalogPanel from "./_components/catalog-panel";
import ConnectionsPanel from "./_components/connections-panel";
import ToolsPanel from "./_components/tools-panel";

export default function IntegrationsPage() {
  const t = useTranslations("Integrations");
  const page = useActionData(loadIntegrationsAction);
  const { data, setData } = page;
  if (!data) return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;

  const panels = { page: data, onPage: setData };
  const tabs = [
    { id: "catalog", label: t("tabs", { tab: "catalog" }), panel: <CatalogPanel {...panels} /> },
    { id: "tools", label: t("tabs", { tab: "tools" }), panel: <ToolsPanel {...panels} /> },
    { id: "connections", label: t("tabs", { tab: "connections" }), panel: <ConnectionsPanel {...panels} /> },
    { id: "access", label: t("tabs", { tab: "access" }), panel: <AccessPanel {...panels} /> },
    { id: "agent", label: t("tabs", { tab: "agent" }), panel: <AgentPanel {...panels} /> },
    { id: "activity", label: t("tabs", { tab: "activity" }), panel: <ActivityPanel {...panels} /> },
  ];

  return (
    <div className="space-y-5">
      <PageHeader icon={Waypoints} title={t("title")} subtitle={t("subtitle")} />
      <LoadError state={page} />
      {data.canManage ? null : (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label={t("stats.published")} value={String(data.stats.published)} />
        <StatCard label={t("stats.denied")} value={String(data.stats.denied)} tone={data.stats.denied ? "danger" : "neutral"} />
        <StatCard label={t("stats.failed")} value={String(data.stats.failed)} tone={data.stats.failed ? "warning" : "neutral"} />
        <StatCard label={t("stats.approvals")} value={String(data.stats.pendingApprovals)} />
        <StatCard label={t("stats.healthy")} value={String(data.stats.healthy)} tone="success" />
      </div>
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
