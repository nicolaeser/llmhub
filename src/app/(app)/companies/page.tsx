"use client";

import { useEffect, useState } from "react";
import { Button, buttonVariants, Card, Chip, SearchField, Table, useOverlayState } from "@heroui/react";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { Link, useRouter } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { companyHref, companyStatus, legacyCompanyLink, matchesCompany } from "@/lib/tenancy/company-view";
import type { CompanyRow, CompanyStatus } from "@/types/structure";
import { useConsoleScope } from "../_components/console-scope";
import { loadCompanyDirectoryAction, locateNodeAction } from "./_action";
import AddCompanyDialog from "./_components/add-company-dialog";
import CompanyDetail from "./_components/company-detail";
import SpendMeter from "./_components/spend-meter";
import { parseNodeRef } from "./_components/tree-model";

const STATUS_COLORS: Record<CompanyStatus, "danger" | "warning" | "default" | "success"> = {
  exhausted: "danger",
  near: "warning",
  empty: "default",
  ok: "success",
};

export default function CompaniesPage() {
  const t = useTranslations("Companies");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const router = useRouter();
  const consoleScope = useConsoleScope();
  const nodeParam = useSearchParam("node");
  const [query, setQuery] = useState("");
  const [addKey, setAddKey] = useState(0);
  const addState = useOverlayState();
  const page = useActionData(loadCompanyDirectoryAction);
  const { data } = page;
  const companyScope = consoleScope.scope.kind === "company" ? consoleScope.scope : null;

  useEffect(() => {
    const legacy = companyScope ? null : parseNodeRef(nodeParam);
    if (!legacy) return;
    if (legacy.kind === "key") {
      router.replace(`/keys/${encodeURIComponent(legacy.id)}`);
      return;
    }
    const ref = { kind: legacy.kind, id: legacy.id };
    let active = true;
    void locateNodeAction(ref).then((result) => {
      if (!active) return;
      router.replace(isActionFail(result) ? "/companies" : companyHref(legacyCompanyLink(ref, result.orgId), true));
    });
    return () => {
      active = false;
    };
  }, [companyScope, nodeParam, router]);

  if (companyScope) return <CompanyDetail key={companyScope.id} orgId={companyScope.id} />;

  const subtitle = t("subtitle");

  if (!data || parseNodeRef(nodeParam)) {
    return <PageStatus icon={Building2} title={t("title")} subtitle={subtitle} state={page} />;
  }

  const rows = data.rows.filter((row) => matchesCompany(row, query));
  const addButton = data.canManage ? (
    <Button
      onPress={() => {
        setAddKey((n) => n + 1);
        addState.open();
      }}
    >
      <Plus size={16} aria-hidden />
      {t("createOrg")}
    </Button>
  ) : null;

  function statusChip(row: CompanyRow) {
    const status = companyStatus(row);
    return (
      <Chip size="sm" variant="soft" color={STATUS_COLORS[status]}>
        {t("status", { status })}
      </Chip>
    );
  }

  const count = (value: number) => format.number(value, "integer");
  const meter = (row: CompanyRow) => <SpendMeter budget={row.budget} label={t("directory.usage", { name: row.alias })} />;
  const open = (row: CompanyRow) => (
    <Link
      href={companyHref({ orgId: row.id, tab: null, node: null }, true)}
      aria-label={t("directory.open", { name: row.alias })}
      className={buttonVariants({ isIconOnly: true, size: "sm", variant: "ghost" })}
    >
      <ChevronRight size={14} aria-hidden />
    </Link>
  );
  const name = (row: CompanyRow) => (
    <Link href={companyHref({ orgId: row.id, tab: null, node: null }, true)} className="break-words text-foreground">
      {row.alias}
    </Link>
  );

  return (
    <div>
      <PageHeader
        icon={Building2}
        title={t("title")}
        subtitle={subtitle}
        actions={data.rows.length ? (addButton ?? undefined) : undefined}
      />

      {data.rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t("emptyTitle")}
          description={t("empty", { manage: data.canManage ? "yes" : "no" })}
          action={addButton ?? undefined}
        />
      ) : (
        <div className="space-y-4">
          <SearchField value={query} onChange={setQuery} aria-label={t("directory.search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("directory.search")} />
              <SearchField.ClearButton aria-label={t("directory.clear")} />
            </SearchField.Group>
          </SearchField>

          {rows.length === 0 ? (
            <Card>
              <Card.Content>
                <p className="text-sm text-muted">{t("directory.noMatches")}</p>
              </Card.Content>
            </Card>
          ) : (
            <>
              <RowCards label={t("title")}>
                {rows.map((row) => (
                  <RowCard
                    key={row.id}
                    title={name(row)}
                    aside={open(row)}
                    chips={statusChip(row)}
                    details={[
                      { label: t("directory.columns.teams"), value: count(row.teams) },
                      { label: t("directory.columns.projects"), value: count(row.projects) },
                      { label: t("directory.columns.members"), value: count(row.members) },
                      ...(data.canSeeKeys ? [{ label: t("directory.columns.keys"), value: count(row.keys) }] : []),
                      { label: t("directory.columns.budget"), value: meter(row), wide: true },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t("title")} className="min-w-3xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("directory.columns.company")}</Table.Column>
                      <Table.Column>{t("directory.columns.teams")}</Table.Column>
                      <Table.Column>{t("directory.columns.projects")}</Table.Column>
                      <Table.Column>{t("directory.columns.members")}</Table.Column>
                      {data.canSeeKeys ? <Table.Column>{t("directory.columns.keys")}</Table.Column> : null}
                      <Table.Column>{t("directory.columns.budget")}</Table.Column>
                      <Table.Column>{tCommon("status")}</Table.Column>
                      <Table.Column>
                        <span className="sr-only">{tCommon("actions")}</span>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {rows.map((row) => (
                        <Table.Row key={row.id} id={row.id}>
                          <Table.Cell>
                            <span className="text-sm font-medium">{name(row)}</span>
                          </Table.Cell>
                          <Table.Cell className="tabular-nums">{count(row.teams)}</Table.Cell>
                          <Table.Cell className="tabular-nums">{count(row.projects)}</Table.Cell>
                          <Table.Cell className="tabular-nums">{count(row.members)}</Table.Cell>
                          {data.canSeeKeys ? <Table.Cell className="tabular-nums">{count(row.keys)}</Table.Cell> : null}
                          <Table.Cell>
                            <div className="w-48">{meter(row)}</div>
                          </Table.Cell>
                          <Table.Cell>{statusChip(row)}</Table.Cell>
                          <Table.Cell>
                            <div className="flex justify-end">{open(row)}</div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
        </div>
      )}

      <AddCompanyDialog
        key={addKey}
        state={addState}
        onCreated={(company) => {
          consoleScope.refresh();
          router.push(companyHref({ orgId: company.id, tab: null, node: null }, true));
        }}
      />
    </div>
  );
}
