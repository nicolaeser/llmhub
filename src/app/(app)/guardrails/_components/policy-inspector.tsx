"use client";

import { Button, Card } from "@heroui/react";
import { Pencil, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { fullLayer, refKey, sectionSummaries } from "@/lib/gateway/safety/policy-layers";
import type { PolicyRef, PolicyTarget } from "@/types/guardrails";
import { SECTION_ICONS, SectionChip, SectionDetail, useSourceLabel } from "@/components/guardrails/policy-labels";
import PolicyTargetPicker from "./policy-target-picker";
import { effectiveFor, findTarget, type PolicyBook } from "./policy-view";

export default function PolicyInspector({
  book,
  value,
  onChange,
  canManage,
  onEdit,
}: {
  book: PolicyBook;
  value: PolicyRef | null;
  onChange: (ref: PolicyRef | null) => void;
  canManage: boolean;
  onEdit: (target: PolicyTarget) => void;
}) {
  const t = useTranslations("Guardrails");
  const sourceLabel = useSourceLabel((ref) => findTarget(book, ref)?.alias);
  const target = findTarget(book, value);
  const effective = target ? effectiveFor(book, target) : null;
  const hasOverride = target ? book.overrides.some((row) => refKey(row.target) === refKey(target)) : false;

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("inspector.title")}</Card.Title>
        <Card.Description>{t("inspector.hint")}</Card.Description>
      </Card.Header>
      <Card.Content className="gap-4">
        <PolicyTargetPicker targets={book.targets} value={value} onChange={onChange} />
        {effective ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("inspector.title")}>
            {sectionSummaries(fullLayer(effective)).map((summary) => {
              const source = effective.sources[summary.section];
              const own = source !== null && target !== undefined && refKey(source) === refKey(target);
              return (
                <li key={summary.section} className="min-w-0">
                  <Card variant="secondary" className="h-full gap-3">
                    <div className="flex items-center gap-2">
                      <IconTile icon={SECTION_ICONS[summary.section]} size="sm" tone={own ? "accent" : "neutral"} />
                      <p className="text-sm font-medium">{t("section", { section: summary.section })}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SectionChip summary={summary} />
                      <SectionDetail summary={summary} />
                    </div>
                    <p className="mt-auto text-xs break-words text-muted">
                      {own ? t("inspector.own") : t("inspector.from", { source: sourceLabel(source) })}
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("inspector.empty")}</p>
        )}
      </Card.Content>
      {target && canManage ? (
        <Card.Footer>
          <Button size="sm" variant="secondary" onPress={() => onEdit(target)}>
            {hasOverride ? <Pencil size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
            {t("inspector.edit", { mode: hasOverride ? "edit" : "create" })}
          </Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
