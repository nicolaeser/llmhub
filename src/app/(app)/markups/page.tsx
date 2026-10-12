"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Card, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { BadgePercent, Building2, FolderKanban, Globe, Pencil, Plus, Trash2, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import StatCard from "@/components/console/stat-card";
import { deleteMarkupAction, loadMarkupsAction } from "@/app/(app)/markups/_action";
import { isActionFail } from "@/lib/http/action-result";
import { isModelPattern, marginShare, markupScopeRank } from "@/lib/gateway/markup-policy";
import type { MarkupRule, MarkupScope, MarkupsPayload, MarkupView } from "@/types/pricing";
import MarkupDialog from "./_components/markup-dialog";
import MarkupLookup from "./_components/markup-lookup";

const SCOPE_ICONS = {
  all: Globe,
  org: Building2,
  team: Users,
  project: FolderKanban,
} as const satisfies Record<MarkupScope, LucideIcon>;

const PRECEDENCE = ["project", "team", "org", "all"] as const satisfies readonly MarkupScope[];

export default function MarkupsPage() {
  const t = useTranslations("Markups");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MarkupsPayload | null>(null);
  const [editing, setEditing] = useState<MarkupView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const formState = useOverlayState();

  useEffect(() => {
    loadMarkupsAction().then((res) => {
      if (!isActionFail(res)) setData(res);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState icon={BadgePercent} title={t("loadFailed")} />
      </div>
    );
  }

  const orgAlias = (id: string) => data.orgs.find((org) => org.id === id)?.alias ?? "";

  function target(rule: MarkupRule): { label: string; detail: string } {
    if (!data || rule.scope === "all") return { label: t("scope", { scope: "all" }), detail: "" };
    const missing = { label: t("deletedTarget", { scope: rule.scope }), detail: rule.targetId };
    if (rule.scope === "org") {
      const org = data.orgs.find((row) => row.id === rule.targetId);
      return org ? { label: org.alias, detail: t("scope", { scope: "org" }) } : missing;
    }
    if (rule.scope === "team") {
      const team = data.teams.find((row) => row.id === rule.targetId);
      return team
        ? { label: team.alias, detail: format.list([t("scope", { scope: "team" }), orgAlias(team.orgId)].filter(Boolean), { type: "unit" }) }
        : missing;
    }
    const project = data.projects.find((row) => row.id === rule.targetId);
    if (!project) return missing;
    const team = data.teams.find((row) => row.id === project.teamId);
    return {
      label: project.alias,
      detail: format.list(
        [t("scope", { scope: "project" }), orgAlias(project.orgId), team?.alias ?? ""].filter(Boolean),
        { type: "unit" },
      ),
    };
  }

  function describe(rule: MarkupRule): string {
    return t("ruleName", { target: target(rule).label, models: rule.model || t("allModels") });
  }

  function openDialog(markup: MarkupView | null) {
    setEditing(markup);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function saved(markup: MarkupView) {
    setData((current) =>
      current
        ? {
            ...current,
            markups: current.markups.some((row) => row.id === markup.id)
              ? current.markups.map((row) => (row.id === markup.id ? markup : row))
              : [...current.markups, markup],
          }
        : current,
    );
  }

  function remove(id: string) {
    setDeleting(id);
    startDelete(async () => {
      const result = await deleteMarkupAction(id);
      setDeleting(null);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setData((current) =>
        current ? { ...current, markups: current.markups.filter((row) => row.id !== result.id) } : current,
      );
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  const markups = [...data.markups].sort(
    (a, b) =>
      markupScopeRank(a.scope) - markupScopeRank(b.scope) ||
      target(a).label.localeCompare(target(b).label) ||
      a.model.localeCompare(b.model),
  );
  const margin = data.totals.sale - data.totals.purchase;
  const share = marginShare(data.totals.purchase, data.totals.sale);
  const createButton = data.canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : undefined;

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={markups.length ? createButton : undefined} />

      {data.canManage ? null : (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t("summary.purchase", { days: data.windowDays })}
          value={format.number(data.totals.purchase, "currency")}
        />
        <StatCard
          label={t("summary.sale", { days: data.windowDays })}
          value={format.number(data.totals.sale, "currency")}
        />
        <StatCard
          label={t("summary.margin", { days: data.windowDays })}
          value={
            share === null
              ? format.number(margin, "currency")
              : t("summary.marginValue", { amount: margin, share })
          }
        />
      </div>

      {markups.length === 0 ? (
        <EmptyState icon={BadgePercent} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <Table aria-label={t("title")}>
          <Table.ScrollContainer>
            <Table.Content aria-label={t("title")} className="min-w-[48rem]">
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.scope")}</Table.Column>
                <Table.Column>{t("columns.model")}</Table.Column>
                <Table.Column>{t("columns.percent")}</Table.Column>
                <Table.Column>{t("columns.note")}</Table.Column>
                <Table.Column>{tCommon("actions")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {markups.map((markup) => {
                  const Icon = SCOPE_ICONS[markup.scope];
                  const where = target(markup);
                  return (
                    <Table.Row key={markup.id} id={markup.id}>
                      <Table.Cell>
                        <div className="flex items-center gap-3">
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                            <Icon size={14} aria-hidden />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{where.label}</div>
                            {where.detail ? <div className="truncate text-xs text-muted">{where.detail}</div> : null}
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        {markup.model ? (
                          <div>
                            <div className="font-mono text-sm">{markup.model}</div>
                            <div className="text-xs text-muted">
                              {t("modelKind", { kind: isModelPattern(markup.model) ? "pattern" : "one" })}
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-muted">{t("allModels")}</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <span
                          className={
                            markup.percent > 0
                              ? "font-semibold text-success tabular-nums"
                              : markup.percent < 0
                                ? "font-semibold text-warning tabular-nums"
                                : "font-semibold text-muted tabular-nums"
                          }
                        >
                          {format.number(markup.percent / 100, "markup")}
                        </span>
                        <div className="text-xs text-muted">
                          {t("kind", { kind: markup.percent > 0 ? "markup" : markup.percent < 0 ? "discount" : "none" })}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm text-muted">{markup.note || tCommon("none")}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {data.canManage ? (
                          <div className="flex gap-1">
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={tCommon("edit")}
                              onPress={() => openDialog(markup)}
                            >
                              <Pencil size={14} aria-hidden />
                            </Button>
                            <ConfirmDialog
                              title={t("deleteConfirm", { rule: describe(markup) })}
                              description={t("deleteHint")}
                              confirmLabel={tCommon("delete")}
                              cancelLabel={tCommon("cancel")}
                              pending={deleting === markup.id}
                              onConfirm={() => remove(markup.id)}
                            >
                              <Button
                                isIconOnly
                                size="sm"
                                variant="danger-soft"
                                aria-label={tCommon("delete")}
                                isPending={deleting === markup.id}
                              >
                                <Trash2 size={14} aria-hidden />
                              </Button>
                            </ConfirmDialog>
                          </div>
                        ) : null}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="gap-4">
          <Card.Header>
            <Card.Title>{t("precedence.title")}</Card.Title>
            <Card.Description>{t("precedence.body")}</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-4">
            <ol className="grid gap-2 sm:grid-cols-2">
              {PRECEDENCE.map((scope, index) => {
                const Icon = SCOPE_ICONS[scope];
                return (
                  <li key={scope} className="flex items-center gap-3 rounded-lg bg-default px-3 py-2">
                    <span className="text-xs font-semibold text-muted tabular-nums">
                      {format.number(index + 1, "integer")}
                    </span>
                    <Icon size={14} aria-hidden className="text-accent" />
                    <span className="text-sm font-medium">{t("scope", { scope })}</span>
                  </li>
                );
              })}
            </ol>
            <p className="text-sm text-muted">{t("precedence.models")}</p>
            <p className="text-sm text-muted">{t("precedence.billing")}</p>
          </Card.Content>
        </Card>
        <MarkupLookup
          markups={data.markups}
          orgs={data.orgs}
          teams={data.teams}
          projects={data.projects}
          models={data.models}
          describe={describe}
        />
      </div>

      <MarkupDialog
        key={dialogKey}
        state={formState}
        editing={editing}
        orgs={data.orgs}
        teams={data.teams}
        projects={data.projects}
        models={data.models}
        onSaved={saved}
      />
    </div>
  );
}
