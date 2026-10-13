"use client";

import { Tabs } from "@heroui/react";
import { useTabParam } from "@/lib/hooks/use-search-param";
import type { PageTab } from "@/types/console";

export default function PageTabs({ label, tabs }: { label: string; tabs: readonly PageTab[] }) {
  const [selected, select] = useTabParam(tabs.map((tab) => tab.id));
  if (tabs.length < 2) return tabs[0]?.panel ?? null;
  return (
    <Tabs selectedKey={selected} onSelectionChange={(key) => select(String(key))}>
      <Tabs.ListContainer className="w-fit max-w-full">
        <Tabs.List aria-label={label}>
          {tabs.map((tab) => (
            <Tabs.Tab key={tab.id} id={tab.id} className="w-auto">
              {tab.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.id} id={tab.id}>
          {tab.panel}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
