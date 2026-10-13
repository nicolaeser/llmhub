"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Chip,
  SearchField,
  Table,
  toast,
  useOverlayState,
} from "@heroui/react";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import GettingStarted from "./_components/getting-started";
import { bindingKind, parsePreset, placeOf } from "./_components/key-binding";
import { KeyDialog } from "./_components/key-dialog";
import { loadKeysPageAction, revokeKeyAction, rotateKeyAction, setBudgetAction } from "./_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { KeyOptions, KeyPreset, VirtualKeyView } from "@/types/keys";
import type { BudgetResult, BudgetView } from "@/types/structure";

function keyBudget(row: VirtualKeyView): BudgetView {
  return {
    maxBudget: row.max_budget,
    spend: row.spend,
    budgetDuration: row.budget_duration,
    boost: 0,
    boosts: [],
    resetsAt: null,
    projectedMonth: 0,
    daysToExhaust: null,
    pctUsed: null,
  };
}

export default function KeysPage() {
  const t = useTranslations("Keys");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [budgetKey, setBudgetKey] = useState<VirtualKeyView | null>(null);
  const [query, setQuery] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<VirtualKeyView | null>(null);
  const [preset, setPreset] = useState<KeyPreset | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busy, setBusy] = useState<{ id: string; action: "rotate" | "revoke" } | null>(null);
  const [, start] = useTransition();
  const dialogState = useOverlayState();
  const budgetState = useOverlayState();

  function openDialog(row: VirtualKeyView | null, next: KeyPreset | null = null) {
    setEditing(row);
    setPreset(next);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  const page = useActionData(loadKeysPageAction, (loaded) => {
    const requested = parsePreset(new URLSearchParams(window.location.search).get("new"));
    if (!requested || !loaded.canManage) return;
    window.history.replaceState(null, "", window.location.pathname);
    openDialog(null, requested);
  });
  const { data, setData } = page;
  const keys = data?.keys;

  function openBudget(row: VirtualKeyView) {
    setBudgetKey(row);
    setDialogKey((n) => n + 1);
    budgetState.open();
  }

  function setKeys(update: (current: VirtualKeyView[]) => VirtualKeyView[]) {
    setData((current) => ({ ...current, keys: update(current.keys) }));
  }

  function applyBudget(result: BudgetResult) {
    setKeys((current) =>
      current.map((k) =>
        k.token_id === result.id
          ? {
              ...k,
              max_budget: result.budget.maxBudget,
              spend: result.budget.spend,
              budget_duration: result.budget.budgetDuration,
            }
          : k,
      ),
    );
  }

  function upsertKey(row: VirtualKeyView) {
    setKeys((current) =>
      current.some((k) => k.token_id === row.token_id)
        ? current.map((k) => (k.token_id === row.token_id ? row : k))
        : [row, ...current],
    );
  }

  function rotate(id: string) {
    setBusy({ id, action: "rotate" });
    start(async () => {
      const result = await rotateKeyAction(id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      const { key: rotated, ...row } = result.key;
      upsertKey(row);
      setSecret(rotated);
      toast(t("toasts.rotated"), { variant: "success" });
    });
  }

  function revoke(id: string) {
    setBusy({ id, action: "revoke" });
    start(async () => {
      const result = await revokeKeyAction(id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setKeys((current) => current.filter((k) => k.token_id !== result.id));
      toast(t("toasts.revoked"), { variant: "success" });
    });
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return (keys ?? []).filter(
      (k) =>
        !q ||
        k.key_alias.toLowerCase().includes(q) ||
        k.key_name.toLowerCase().includes(q) ||
        k.token_id.toLowerCase().includes(q),
    );
  }, [keys, query]);

  if (!data) {
    return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const { canManage, canBind, canBudget, overview, owners } = data;
  const options: KeyOptions = {
    companyId: data.companyId,
    orgs: data.orgs,
    teams: data.teams,
    projects: data.projects,
    members: data.members,
    models: data.models,
    templates: data.templates,
  };

  function accessLabel(row: VirtualKeyView): string {
    if (!row.templates.length && !row.models.length) return t("allModels");
    const names = options.templates
      .filter((template) => row.templates.includes(template.id))
      .map((template) => template.name);
    return format.list(
      row.models.length ? [...names, t("modelCount", { count: row.models.length })] : names,
      { type: "unit" },
    );
  }

  function binding(row: VirtualKeyView) {
    const kind = bindingKind(row);
    const target =
      kind === "project"
        ? options.projects.find((item) => item.id === row.project_id)
        : kind === "member"
          ? options.members.find((item) => item.id === row.member_id)
          : undefined;
    const place = placeOf(options, row.org_id, row.team_id);
    const name = target?.alias ?? (kind === "internal" ? owners[row.user_id] : undefined);
    return {
      name: name || tCommon("none"),
      path: t("binding.path", {
        kind,
        hasPlace: place.org ? "yes" : "no",
        place: t("binding.place", { org: place.org, team: place.team, hasTeam: place.team ? "yes" : "no" }),
      }),
    };
  }

  const createButton = canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  ) : undefined;
  const setupIncomplete =
    canManage && (data.providers === 0 || options.models.length === 0 || data.keys.length === 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={data.keys.length ? createButton : undefined}
      />

      {setupIncomplete ? (
        <GettingStarted
          providers={data.providers}
          models={options.models.length}
          keys={data.keys.length}
          onCreateKey={() => openDialog(null)}
        />
      ) : null}

      {secret ? (
        <Alert status="success">
          <Alert.Content>
            <Alert.Title>{t("secretTitle")}</Alert.Title>
            <Alert.Description>
              {t("secretHint")}
              <code className="mt-2 block break-all font-mono text-sm">{secret}</code>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {data.keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={t("emptyTitle")}
          description={t("empty")}
          action={createButton}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t("overview.keys")} value={format.number(data.keys.length, "integer")} />
            <StatCard
              label={t("overview.spend")}
              value={format.number(overview.spend7d, "money")}
            />
            <StatCard
              label={t("overview.requests")}
              value={format.number(overview.requests7d, "integer")}
            />
            <StatCard
              label={t("overview.errors")}
              value={format.number(overview.errors7d, "integer")}
            />
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            aria-label={t("searchPlaceholder")}
            className="max-w-sm"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("searchPlaceholder")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
          {filtered.length === 0 ? (
            <EmptyState icon={KeyRound} title={t("noMatches")} />
          ) : (
            <Table aria-label={t("title")}>
              <Table.ScrollContainer>
                <Table.Content>
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                    <Table.Column>{t("columns.binding")}</Table.Column>
                    <Table.Column>{t("columns.access")}</Table.Column>
                    <Table.Column>{t("columns.spend")}</Table.Column>
                    <Table.Column>{t("columns.status")}</Table.Column>
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filtered.map((row) => {
                      const bound = binding(row);
                      return (
                        <Table.Row key={row.token_id} id={row.token_id}>
                          <Table.Cell>
                            <div className="font-medium">{row.key_alias || tCommon("none")}</div>
                            <div className="font-mono text-xs text-muted">{row.key_name}…</div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="min-w-0">
                              <p className="text-sm">{bound.name}</p>
                              <p className="text-xs text-muted">{bound.path}</p>
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <span className="text-sm">{accessLabel(row)}</span>
                          </Table.Cell>
                          <Table.Cell>
                            {tCommon("spendBudget", {
                              hasCap: row.max_budget > 0 ? "yes" : "no",
                              spend: row.spend,
                              budget: row.max_budget,
                            })}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-1">
                              <Chip size="sm" variant="soft">
                                {tCommon("blockedState", {
                                  blocked: row.blocked ? "true" : "false",
                                })}
                              </Chip>
                              {row.log_content ? null : (
                                <Chip size="sm" variant="soft" color="warning">
                                  {t("contentOff")}
                                </Chip>
                              )}
                              {row.allowed_endpoints.length ? (
                                <Chip size="sm" variant="soft">
                                  {t("endpointChip", {
                                    endpoints: format.list(
                                      row.allowed_endpoints.map((endpoint) => t("endpoints.name", { endpoint })),
                                      { type: "conjunction" },
                                    ),
                                  })}
                                </Chip>
                              ) : null}
                              {row.access_windows.length ? (
                                <Chip size="sm" variant="soft">
                                  {t("windowChip")}
                                </Chip>
                              ) : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex gap-1">
                              {canManage ? (
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label={t("edit")}
                                  onPress={() => openDialog(row)}
                                >
                                  <Pencil size={14} aria-hidden />
                                </Button>
                              ) : null}
                              {canBudget ? (
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  aria-label={t("budget")}
                                  onPress={() => openBudget(row)}
                                >
                                  <Wallet size={14} aria-hidden />
                                </Button>
                              ) : null}
                              {canManage ? (
                                <>
                                  <ConfirmDialog
                                    title={t("rotateConfirm.title", { name: row.key_alias || row.key_name })}
                                    description={t("rotateConfirm.description")}
                                    confirmLabel={t("rotate")}
                                    cancelLabel={tCommon("cancel")}
                                    onConfirm={() => rotate(row.token_id)}
                                  >
                                    <Button
                                      isIconOnly
                                      size="sm"
                                      variant="ghost"
                                      aria-label={t("rotate")}
                                      isPending={busy?.id === row.token_id && busy.action === "rotate"}
                                      isDisabled={busy !== null && busy.id !== row.token_id}
                                    >
                                      <RefreshCw size={14} aria-hidden />
                                    </Button>
                                  </ConfirmDialog>
                                  <ConfirmDialog
                                    title={t("revokeConfirm.title", { name: row.key_alias || row.key_name })}
                                    description={t("revokeConfirm.description")}
                                    confirmLabel={t("revoke")}
                                    cancelLabel={tCommon("cancel")}
                                    onConfirm={() => revoke(row.token_id)}
                                  >
                                    <Button
                                      isIconOnly
                                      size="sm"
                                      variant="danger-soft"
                                      aria-label={t("revoke")}
                                      isPending={busy?.id === row.token_id && busy.action === "revoke"}
                                      isDisabled={busy !== null && busy.id !== row.token_id}
                                    >
                                      <Trash2 size={14} aria-hidden />
                                    </Button>
                                  </ConfirmDialog>
                                </>
                              ) : null}
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </>
      )}

      <BudgetDialog
        key={`budget-${dialogKey}`}
        state={budgetState}
        target={
          budgetKey
            ? { kind: "key", id: budgetKey.token_id, alias: budgetKey.key_alias || budgetKey.key_name }
            : null
        }
        budget={budgetKey ? keyBudget(budgetKey) : null}
        ancestors={[]}
        onSubmit={setBudgetAction}
        onSaved={applyBudget}
      />
      <KeyDialog
        key={dialogKey}
        state={dialogState}
        editing={editing}
        preset={preset}
        options={options}
        canBind={canBind}
        onSaved={(row, created) => {
          upsertKey(row);
          if (created) setSecret(created);
        }}
      />
    </div>
  );
}
