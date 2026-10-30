"use client";

import { buttonVariants, Card, Chip } from "@heroui/react";
import { ChevronRight, Shield, UserCog } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import { SectionChip, SectionDetail, useSectionText } from "@/components/guardrails/policy-labels";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import type { ActionFail } from "@/types/actions";
import type { CompanyPolicies, PolicyOverrideSummary } from "@/types/guardrails";
import type { ConsoleUserNode } from "@/types/structure";

type PolicyLoader = (orgId: string) => Promise<CompanyPolicies | ActionFail>;

function PolicySummary({
  orgId,
  load,
  hrefOf,
}: {
  orgId: string;
  load: PolicyLoader;
  hrefOf: (row: PolicyOverrideSummary) => string | null;
}) {
  const t = useTranslations("Companies.access.policies");
  const sectionText = useSectionText();
  const state = useActionData(() => load(orgId));

  if (!state.data) {
    return state.error === null ? <SectionLoading shape="details" rows={2} /> : <LoadError state={state} />;
  }

  const { sections, overrides } = state.data;

  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        {sections.map((summary) => (
          <div key={summary.section} className="min-w-0 space-y-1">
            <dt className="text-xs text-muted">{t("section", { section: summary.section })}</dt>
            <dd className="flex flex-wrap items-center gap-2 text-sm">
              <SectionChip summary={summary} />
              <SectionDetail summary={summary} />
            </dd>
            <dd className="text-xs text-muted">{t("level", { level: summary.level })}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("overrides", { count: overrides.length })}</h4>
        {overrides.length === 0 ? (
          <p className="text-sm text-muted">{t("overridesEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {overrides.map((row) => {
              const href = hrefOf(row);
              return (
                <li key={`${row.scope}:${row.id}`} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm break-words">
                      <span className="text-muted">{t("scope", { scope: row.scope })}</span>{" "}
                      <span className="font-medium text-foreground">{row.alias}</span>
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {row.sections.map((summary) => (
                        <Chip key={summary.section} size="sm" variant="soft">
                          {t("overrideSection", {
                            section: t("section", { section: summary.section }),
                            value: sectionText(summary),
                          })}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  {href ? (
                    <Link
                      href={href}
                      aria-label={t("openTarget", { alias: row.alias })}
                      className={buttonVariants({ isIconOnly: true, size: "sm", variant: "ghost" })}
                    >
                      <ChevronRight size={14} aria-hidden />
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function AccessTab({
  orgId,
  users,
  loadPolicies,
  hrefOf,
}: {
  orgId: string;
  users: ConsoleUserNode[] | null;
  loadPolicies: PolicyLoader | null;
  hrefOf: (row: PolicyOverrideSummary) => string | null;
}) {
  const t = useTranslations("Companies.access");

  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      {users ? (
        <Card>
          <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <IconTile icon={UserCog} size="sm" />
              <div className="min-w-0">
                <Card.Title>{t("users.title", { count: users.length })}</Card.Title>
                <Card.Description>{t("users.hint")}</Card.Description>
              </div>
            </div>
            <Link
              href={`/users?company=${encodeURIComponent(orgId)}`}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              {t("users.manage")}
            </Link>
          </Card.Header>
          <Card.Content>
            {users.length ? (
              <ul className="flex flex-wrap gap-2" aria-label={t("users.title", { count: users.length })}>
                {users.map((user) => (
                  <li key={user.id} className="min-w-0">
                    <Chip size="sm" variant="soft">
                      <span className="break-all">{user.alias}</span>
                    </Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("users.empty")}</p>
            )}
          </Card.Content>
        </Card>
      ) : null}
      {loadPolicies ? (
        <Card>
          <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <IconTile icon={Shield} size="sm" />
              <div className="min-w-0">
                <Card.Title>{t("policies.title")}</Card.Title>
                <Card.Description>{t("policies.hint")}</Card.Description>
              </div>
            </div>
            <Link href="/guardrails?tab=overrides" className={buttonVariants({ size: "sm", variant: "secondary" })}>
              {t("policies.open")}
            </Link>
          </Card.Header>
          <Card.Content>
            <PolicySummary orgId={orgId} load={loadPolicies} hrefOf={hrefOf} />
          </Card.Content>
        </Card>
      ) : null}
    </div>
  );
}
