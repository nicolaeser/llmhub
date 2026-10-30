"use client";

import { Tabs } from "@heroui/react";
import { useTabParam } from "@/lib/hooks/use-search-param";
import type { PageTab } from "@/types/console";

export default function PageTabs({ label, tabs }: { label: string; tabs: readonly PageTab[] }) {
  const [selected, select] = useTabParam(tabs.map((tab) => tab.id));
  if (tabs.length < 2) return tabs[0]?.panel ?? null;
  if (!selected) return null;
  return (
    <Tabs variant="secondary" selectedKey={selected} onSelectionChange={(key) => select(String(key))}>
      <Tabs.ListContainer>
        <Tabs.List aria-label={label}>
          {tabs.map((tab) => (
            <Tabs.Tab key={tab.id} id={tab.id} className="w-auto whitespace-nowrap">
              {tab.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.id} id={tab.id} className="px-0 pt-2 pb-0">
          {tab.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
