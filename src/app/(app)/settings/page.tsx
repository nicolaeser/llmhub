"use client";

import { useState } from "react";
import { Tabs } from "@heroui/react";
import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import type { SettingsTab } from "@/types/settings";
import { loadSettingsScopeAction } from "./_action";
import CompanyTab from "./_components/company-tab";
import GeneralTab from "./_components/general-tab";
import SignInTab from "./_components/sign-in-tab";
import StorageTab from "./_components/storage-tab";
import LoggingTab from "./_components/logging-tab";
import CacheTab from "./_components/cache-tab";
import CatalogTab from "./_components/catalog-tab";

const PLATFORM_TABS = ["general", "sign-in", "storage", "logging", "cache", "catalog"] as const satisfies readonly SettingsTab[];

export default function SettingsPage() {
  const t = useTranslations("Settings");
  const tabParam = useSearchParam("tab");
  const [picked, setPicked] = useState<SettingsTab | null>(null);
  const page = useActionData(loadSettingsScopeAction);
  const scope = page.data;

  if (!scope) {
    return <PageStatus icon={Settings} title={t("title")} state={page} />;
  }

  const company = scope.company;
  const tabs: SettingsTab[] = [...(company ? (["company"] as const) : []), ...(scope.platform ? PLATFORM_TABS : [])];
  const fallback = tabs[0] ?? "general";
  const tab = [picked, tabParam].map((id) => tabs.find((item) => item === id)).find(Boolean) ?? fallback;

  function select(key: string | number) {
    const next = tabs.find((id) => id === key) ?? fallback;
    setPicked(next);
    window.history.replaceState(null, "", next === fallback ? window.location.pathname : `?tab=${next}`);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Settings}
        title={t("title")}
        subtitle={scope.platform || !company ? t("subtitle") : t("companySubtitle", { name: company.alias })}
      />
      <Tabs selectedKey={tab} onSelectionChange={select} aria-label={t("title")}>
        {tabs.length > 1 ? (
          <Tabs.List className="w-full flex-wrap" aria-label={t("title")}>
            {tabs.map((id) => (
              <Tabs.Tab key={id} id={id} className="w-auto whitespace-nowrap">
                {t("tabs", { tab: id.replace("-", "_") })}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        ) : null}
        {company ? (
          <Tabs.Panel id="company" className="pt-4">
            <CompanyTab company={company} />
          </Tabs.Panel>
        ) : null}
        {scope.platform ? (
          <>
            <Tabs.Panel id="general" className="pt-4">
              <GeneralTab />
            </Tabs.Panel>
            <Tabs.Panel id="sign-in" className="pt-4">
              <SignInTab />
            </Tabs.Panel>
            <Tabs.Panel id="storage" className="pt-4">
              <StorageTab />
            </Tabs.Panel>
            <Tabs.Panel id="logging" className="pt-4">
              <LoggingTab />
            </Tabs.Panel>
            <Tabs.Panel id="cache" className="pt-4">
              <CacheTab />
            </Tabs.Panel>
            <Tabs.Panel id="catalog" className="pt-4">
              <CatalogTab />
            </Tabs.Panel>
          </>
        ) : null}
      </Tabs>
    </div>
  );
}
