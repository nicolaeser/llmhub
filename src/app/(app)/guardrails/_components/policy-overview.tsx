"use client";

import type { ReactNode } from "react";
import { Button, Card, Chip } from "@heroui/react";
import { FlaskConical, KeyRound, Layers, ListChecks, Pencil, ShieldAlert, UserRound, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { SectionChip } from "@/components/guardrails/policy-labels";
import { INJECTION_CHECKS, SECRET_ENTITIES } from "@/lib/gateway/safety/guardrails";
import { fullLayer, sectionSummaries } from "@/lib/gateway/safety/policy-layers";
import type { PolicySection } from "@/types/guardrails";
import type { PolicyBook } from "./policy-view";

const PREVIEW = 3;

const ICONS: Record<PolicySection, LucideIcon> = {
  pii: UserRound,
  injection: ShieldAlert,
  secrets: KeyRound,
  rules: ListChecks,
};

type Fact = { label: string; value: ReactNode; wide?: boolean };

function SummaryCard({
  icon,
  title,
  chip,
  description,
  facts,
  action,
}: {
  icon: LucideIcon;
  title: string;
  chip?: ReactNode;
  description: string;
  facts: Fact[];
  action: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <Card.Header className="flex-row items-start gap-3">
        <IconTile icon={icon} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Card.Title>{title}</Card.Title>
            {chip}
          </div>
          <Card.Description>{description}</Card.Description>
        </div>
      </Card.Header>
      {facts.length ? (
        <Card.Content>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className={fact.wide ? "col-span-full min-w-0" : "min-w-0"}>
                <dt className="text-xs text-muted">{fact.label}</dt>
                <dd className="text-sm break-words text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      ) : null}
      {action ? <Card.Footer className="mt-auto flex-wrap gap-2">{action}</Card.Footer> : null}
    </Card>
  );
}

function NameChips({ names, total }: { names: string[]; total: number }) {
  const t = useTranslations("Guardrails.overview");
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name, index) => (
        <Chip key={`${index}:${name}`} size="sm" variant="soft">
          {name}
        </Chip>
      ))}
      {total > names.length ? (
        <Chip size="sm" variant="soft">
          {t("more", { count: total - names.length })}
        </Chip>
      ) : null}
    </div>
  );
}

export default function PolicyOverview({
  book,
  canEdit,
  onEdit,
  onOpenTab,
}: {
  book: PolicyBook;
  canEdit: boolean;
  onEdit: (section: Exclude<PolicySection, "rules">) => void;
  onOpenTab: (tab: "rules" | "overrides" | "test") => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const { pii } = book.platform;
  const { injection, secrets, rules } = book.platform.guardrails;
  const summaries = sectionSummaries(fullLayer(book.platform));
  const summary = (section: PolicySection) => summaries.find((row) => row.section === section);

  function chip(section: PolicySection) {
    const found = summary(section);
    return found ? <SectionChip summary={found} /> : null;
  }

  function edit(section: Exclude<PolicySection, "rules">) {
    if (!canEdit) return null;
    return (
      <Button size="sm" variant="secondary" onPress={() => onEdit(section)} aria-label={t("overview.editFor", { section })}>
        <Pencil size={14} aria-hidden />
        {tCommon("edit")}
      </Button>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <SummaryCard
          icon={ICONS.pii}
          title={t("section", { section: "pii" })}
          chip={chip("pii")}
          description={t("overview.pii", { enabled: String(pii.enabled), mode: pii.mode })}
          facts={
            pii.enabled
              ? [
                  { label: t("overview.typesLabel"), value: t("overview.types", { count: pii.entities.length }) },
                  { label: t("overview.responsesLabel"), value: t("overview.responses", { output: String(pii.output) }) },
                  { label: t("overview.detectorLabel"), value: t("detectorOption", { detector: pii.detector }) },
                ]
              : []
          }
          action={edit("pii")}
        />
        <SummaryCard
          icon={ICONS.injection}
          title={t("section", { section: "injection" })}
          chip={chip("injection")}
          description={t("overview.injection", { enabled: String(injection.enabled), action: injection.action })}
          facts={
            injection.enabled
              ? [
                  {
                    label: t("overview.checksLabel"),
                    value: t("overview.ofTotal", { count: injection.checks.length, total: INJECTION_CHECKS.length }),
                  },
                ]
              : []
          }
          action={edit("injection")}
        />
        <SummaryCard
          icon={ICONS.secrets}
          title={t("section", { section: "secrets" })}
          chip={chip("secrets")}
          description={t("overview.secrets", { enabled: String(secrets.enabled), action: secrets.action })}
          facts={
            secrets.enabled
              ? [
                  {
                    label: t("overview.detectorsLabel"),
                    value: t("overview.ofTotal", { count: secrets.entities.length, total: SECRET_ENTITIES.length }),
                  },
                ]
              : []
          }
          action={edit("secrets")}
        />
        <SummaryCard
          icon={ICONS.rules}
          title={t("section", { section: "rules" })}
          chip={
            <Chip size="sm" variant="soft">
              {t("rules.count", { count: rules.length })}
            </Chip>
          }
          description={t("overview.rules", { count: rules.length })}
          facts={
            rules.length
              ? [
                  {
                    label: t("overview.rulesLabel"),
                    wide: true,
                    value: <NameChips names={rules.slice(0, PREVIEW).map((rule) => rule.name)} total={rules.length} />,
                  },
                ]
              : []
          }
          action={
            <Button size="sm" variant="secondary" onPress={() => onOpenTab("rules")}>
              <ListChecks size={14} aria-hidden />
              {t("overview.manageRules", { edit: String(canEdit) })}
            </Button>
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SummaryCard
          icon={Layers}
          title={t("overrides.title")}
          description={t("overview.overrides", { count: book.overrides.length })}
          facts={
            book.overrides.length
              ? [
                  {
                    label: t("overrides.target"),
                    wide: true,
                    value: (
                      <NameChips
                        names={book.overrides.slice(0, PREVIEW).map((row) => row.target.alias)}
                        total={book.overrides.length}
                      />
                    ),
                  },
                ]
              : []
          }
          action={
            <Button size="sm" variant="secondary" onPress={() => onOpenTab("overrides")}>
              <Layers size={14} aria-hidden />
              {t("overview.viewOverrides")}
            </Button>
          }
        />
        <SummaryCard
          icon={FlaskConical}
          title={t("test.title")}
          description={t("test.hint")}
          facts={[]}
          action={
            <Button size="sm" variant="secondary" onPress={() => onOpenTab("test")}>
              <FlaskConical size={14} aria-hidden />
              {t("test.open")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
