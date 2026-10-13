"use client";

import { Network } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageTabs from "@/components/console/page-tabs";
import CatalogTab from "./_components/catalog-tab";
import GroupsTab from "./_components/groups-tab";

export default function ModelsPage() {
  const t = useTranslations("Models");

  return (
    <div>
      <PageHeader icon={Network} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs
        label={t("title")}
        tabs={[
          { id: "catalog", label: t("tab", { tab: "catalog" }), panel: <CatalogTab /> },
          { id: "groups", label: t("tab", { tab: "groups" }), panel: <GroupsTab /> },
        ]}
      />
    </div>
  );
}
