"use client";

import { useState } from "react";
import { Tabs } from "@heroui/react";
import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import type { SettingsTab } from "@/types/settings";
import GeneralTab from "./_components/general-tab";
import SignInTab from "./_components/sign-in-tab";
import StorageTab from "./_components/storage-tab";
import LoggingTab from "./_components/logging-tab";
import CacheTab from "./_components/cache-tab";
import CatalogTab from "./_components/catalog-tab";

const TABS = ["general", "sign-in", "storage", "logging", "cache", "catalog"] as const satisfies readonly SettingsTab[];

export default function SettingsPage() {
  const t = useTranslations("Settings");
  const tabParam = useSearchParam("tab");
  const [picked, setPicked] = useState<SettingsTab | null>(null);
  const tab = picked ?? TABS.find((id) => id === tabParam) ?? "general";

  function select(key: string | number) {
    const next = TABS.find((id) => id === key) ?? "general";
    setPicked(next);
    window.history.replaceState(null, "", next === "general" ? window.location.pathname : `?tab=${next}`);
  }

  return (
    <div className="space-y-5">
      <PageHeader icon={Settings} title={t("title")} subtitle={t("subtitle")} />
      <Tabs selectedKey={tab} onSelectionChange={select} aria-label={t("title")}>
        <Tabs.ListContainer className="w-full min-w-0 md:w-fit">
          <Tabs.List aria-label={t("title")}>
            {TABS.map((id) => (
              <Tabs.Tab key={id} id={id} className="w-auto whitespace-nowrap">
                {t("tabs", { tab: id.replace("-", "_") })}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
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
      </Tabs>
    </div>
  );
}
