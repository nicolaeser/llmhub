"use client";

import { useState } from "react";
import { Button, Card, Chip, Disclosure, Separator } from "@heroui/react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import type { ActionFail } from "@/types/actions";
import { SectionChip, SectionDetail } from "@/components/guardrails/policy-labels";
import type { CompanyPolicies, PolicyOverrideSummary } from "@/types/guardrails";
import type { ConsoleUserNode, NodeRef } from "@/types/structure";

type PolicyLoader = (orgId: string) => Promise<CompanyPolicies | ActionFail>;

function PolicySummary({
  orgId,
  load,
  canOpen,
  onOpen,
}: {
  orgId: string;
  load: PolicyLoader;
  canOpen: (ref: NodeRef) => boolean;
  onOpen: (ref: NodeRef) => void;
}) {
  const t = useTranslations("Companies.access.policies");
  const tGuardrails = useTranslations("Guardrails");
  const state = useActionData(() => load(orgId));

  if (!state.data) {
    return state.error === null ? <SectionLoading shape="details" rows={2} /> : <LoadError state={state} />;
  }

  const { sections, overrides } = state.data;

  function overrideChips(row: PolicyOverrideSummary) {
    return row.sections.map((summary) => (
      <Chip key={summary.section} size="sm" variant="soft">
        {t("overrideSection", {
          section: tGuardrails("section", { section: summary.section }),
          value:
            summary.section === "rules"
              ? tGuardrails("rules.count", { count: summary.count })
              : tGuardrails("sectionState", { state: summary.state }),
        })}
      </Chip>
    ));
  }

  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        {sections.map((summary) => (
          <div key={summary.section} className="min-w-0 space-y-1">
            <dt className="text-xs text-muted">{tGuardrails("section", { section: summary.section })}</dt>
            <dd className="flex flex-wrap items-center gap-2 text-sm">
              <SectionChip summary={summary} />
              <SectionDetail summary={summary} />
            </dd>
            <dd className="text-xs text-muted">{t("level", { level: summary.level })}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <p className="text-xs text-muted">{t("overrides", { count: overrides.length })}</p>
        {overrides.length === 0 ? (
          <p className="text-sm text-muted">{t("overridesEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {overrides.map((row) => {
              const ref: NodeRef = { kind: row.scope, id: row.id };
              return (
                <li key={`${row.scope}:${row.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm break-words">
                      <span className="text-muted">{tGuardrails("scopeLabel", { scope: row.scope })}</span>{" "}
                      <span className="font-medium">{row.alias}</span>
                    </p>
                    <div className="flex flex-wrap gap-1">{overrideChips(row)}</div>
                  </div>
                  {canOpen(ref) ? (
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={t("openTarget", { alias: row.alias })}
                      onPress={() => onOpen(ref)}
                    >
                      <ChevronRight size={14} aria-hidden />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Link href="/guardrails?tab=overrides" className="text-sm text-accent">
        {t("open")}
      </Link>
    </div>
  );
}

export default function AccessCard({
  orgId,
  users,
  loadPolicies,
  canOpen,
  onOpen,
}: {
  orgId: string;
  users: ConsoleUserNode[] | null;
  loadPolicies: PolicyLoader | null;
  canOpen: (ref: NodeRef) => boolean;
  onOpen: (ref: NodeRef) => void;
}) {
  const t = useTranslations("Companies.access");
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);

  return (
    <Card>
      <Card.Header>
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={ShieldCheck} size="sm" />
          <div className="min-w-0 space-y-1">
            <Card.Title>{t("title")}</Card.Title>
            <Card.Description>
              {t("hint", { users: users ? "yes" : "no", policies: loadPolicies ? "yes" : "no" })}
            </Card.Description>
          </div>
        </div>
      </Card.Header>
      <Card.Content className="space-y-4">
        {users ? (
          <section className="space-y-2">
            <h4 className="text-sm font-medium">{t("users.title", { count: users.length })}</h4>
            <p className="text-xs text-muted">{t("users.hint")}</p>
            {users.length ? (
              <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t("users.title", { count: users.length })}>
                {users.map((user) => (
                  <li key={user.id} className="min-w-0">
                    <Link
                      href={`/users?company=${encodeURIComponent(orgId)}`}
                      className="text-sm break-words text-accent"
                    >
                      {user.alias}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("users.empty")}</p>
            )}
          </section>
        ) : null}
        {users && loadPolicies ? <Separator /> : null}
        {loadPolicies ? (
          <Disclosure
            isExpanded={expanded}
            onExpandedChange={(open) => {
              setExpanded(open);
              if (open) setOpened(true);
            }}
          >
            <Disclosure.Heading level={4}>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                {t("policies.title")}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <p className="text-xs text-muted">{t("policies.hint")}</p>
            <Disclosure.Content>
              <Disclosure.Body className="pt-3">
                {opened ? <PolicySummary orgId={orgId} load={loadPolicies} canOpen={canOpen} onOpen={onOpen} /> : null}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        ) : null}
      </Card.Content>
    </Card>
  );
}
