"use client";

import { Tabs } from "@heroui/react";
import { useTabParam } from "@/lib/hooks/use-search-param";
import type { PageTab } from "@/types/console";

export default function PageTabs({ label, tabs }: { label: string; tabs: readonly PageTab[] }) {
  const [selected, select] = useTabParam(tabs.map((tab) => tab.id));
  if (tabs.length < 2) return tabs[0]?.panel ?? null;
  if (!selected) return null;
  return (
    <Tabs selectedKey={selected} onSelectionChange={(key) => select(String(key))}>
      <Tabs.List className="w-full flex-wrap" aria-label={label}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.id} id={tab.id} className="w-auto whitespace-nowrap">
            {tab.label}
            <Tabs.Indicator />
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.id} id={tab.id} className="pt-4">
          {tab.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
