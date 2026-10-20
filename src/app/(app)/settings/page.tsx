"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageTabs from "@/components/console/page-tabs";
import type { SettingsTab } from "@/types/settings";
import GeneralTab from "./_components/general-tab";
import SignInTab from "./_components/sign-in-tab";
import StorageTab from "./_components/storage-tab";
import LoggingTab from "./_components/logging-tab";
import CacheTab from "./_components/cache-tab";
import CatalogTab from "./_components/catalog-tab";

export default function SettingsPage() {
  const t = useTranslations("Settings");
  const tab = (id: SettingsTab, panel: React.ReactNode) => ({ id, label: t("tabs", { tab: id.replace("-", "_") }), panel });

  return (
    <div>
      <PageHeader icon={Settings} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs
        label={t("title")}
        tabs={[
          tab("general", <GeneralTab />),
          tab("sign-in", <SignInTab />),
          tab("storage", <StorageTab />),
          tab("logging", <LoggingTab />),
          tab("cache", <CacheTab />),
          tab("catalog", <CatalogTab />),
        ]}
      />
    </div>
  );
}
