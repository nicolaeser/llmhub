"use client";

import { Disclosure } from "@heroui/react";
import { Wrench } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { assistantToolsByGroup, isWriteAccess } from "@/lib/assistant/catalog";
import type { AssistantToolView } from "@/types/assistant";

export default function AssistantTools({
  tools,
  allowWrite,
}: {
  tools: AssistantToolView[];
  allowWrite: boolean;
}) {
  const t = useTranslations("Assistant");
  const format = useFormatter();
  if (!tools.length) return null;
  const writes = new Set(tools.filter((tool) => isWriteAccess(tool.access)).map((tool) => tool.name));
  const usable = allowWrite ? tools.length : tools.length - writes.size;

  return (
    <Disclosure className="mb-4">
      <Disclosure.Heading level={2}>
        <Disclosure.Trigger className="flex w-full items-center gap-2 py-1 text-left text-sm text-muted">
          <Wrench size={14} aria-hidden />
          {t("tools.summary", { usable, total: tools.length })}
          <Disclosure.Indicator className="ml-auto shrink-0" />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto pt-2">
          <ul className="grid gap-3 text-sm sm:grid-cols-2">
            {assistantToolsByGroup(tools.map((tool) => tool.name)).map(({ group, tools: names }) => {
              const reads = names.filter((name) => !writes.has(name));
              const changes = names.filter((name) => writes.has(name));
              return (
                <li key={group} className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-foreground">{t("tools.group", { group })}</span>
                  {reads.length ? (
                    <span className="text-muted">
                      {t("tools.reads", { list: format.list(reads.map((name) => t("toolName", { name }))) })}
                    </span>
                  ) : null}
                  {changes.length ? (
                    <span className={allowWrite ? "text-warning" : "text-muted"}>
                      {t("tools.changes", {
                        list: format.list(changes.map((name) => t("toolName", { name }))),
                      })}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">{t("tools.hint", { state: allowWrite ? "on" : "off" })}</p>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
