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
import { Activity, AlertTriangle, Blocks, CircleDollarSign, KeyRound, Pencil, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useConsoleScope } from "../../_components/console-scope";
import GettingStarted from "./getting-started";
import { bindingKind, parsePreset, placeOf } from "./key-binding";
import { KeyDialog } from "./key-dialog";
import KeyMcpDialog from "./key-mcp-dialog";
import { loadKeysPageAction, revokeKeyAction, rotateKeyAction, setBudgetAction } from "../_action";
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

export default function KeysTab() {
  const t = useTranslations("Keys");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const scope = useConsoleScope();
  const [budgetKey, setBudgetKey] = useState<VirtualKeyView | null>(null);
  const [mcpKey, setMcpKey] = useState<VirtualKeyView | null>(null);
  const [query, setQuery] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<VirtualKeyView | null>(null);
  const [preset, setPreset] = useState<KeyPreset | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busy, setBusy] = useState<{ id: string; action: "rotate" | "revoke" } | null>(null);
  const [, start] = useTransition();
  const dialogState = useOverlayState();
  const budgetState = useOverlayState();
  const mcpState = useOverlayState();

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

  function openMcp(row: VirtualKeyView) {
    setMcpKey(row);
    setDialogKey((n) => n + 1);
    mcpState.open();
  }

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
    return <PageStatus state={page} stats={4} />;
  }

  const { canManage, canBind, canBudget, canMcp, overview, owners } = data;
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

  function spendLabel(row: VirtualKeyView) {
    return tCommon("spendBudget", {
      hasCap: row.max_budget > 0 ? "yes" : "no",
      spend: row.spend,
      budget: row.max_budget,
    });
  }

  function keyChips(row: VirtualKeyView) {
    return (
      <>
        <Chip size="sm" variant="soft" color={row.blocked ? "danger" : "success"}>
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
      </>
    );
  }

  function keyActions(row: VirtualKeyView) {
    const name = row.key_alias || row.key_name;
    return (
      <>
        {canManage ? (
          <Button isIconOnly size="sm" variant="ghost" aria-label={t("edit")} onPress={() => openDialog(row)}>
            <Pencil size={14} aria-hidden />
          </Button>
        ) : null}
        {canMcp ? (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t("mcp.open", { name })}
            onPress={() => openMcp(row)}
          >
            <Blocks size={14} aria-hidden />
          </Button>
        ) : null}
        {canBudget ? (
          <Button isIconOnly size="sm" variant="ghost" aria-label={t("budget")} onPress={() => openBudget(row)}>
            <Wallet size={14} aria-hidden />
          </Button>
        ) : null}
        {canManage ? (
          <>
            <ConfirmDialog
              title={t("rotateConfirm.title", { name })}
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
              title={t("revokeConfirm.title", { name })}
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
      </>
    );
  }

  const createButton = canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  ) : undefined;
  const setupIncomplete =
    canManage &&
    scope.kind === "platform" &&
    (data.providers === 0 || options.models.length === 0 || data.keys.length === 0);

  return (
    <div className="space-y-5">
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
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={KeyRound}
              label={t("overview.keys")}
              value={format.number(data.keys.length, "integer")}
            />
            <StatCard
              icon={CircleDollarSign}
              label={t("overview.spend")}
              value={format.number(overview.spend7d, "money")}
            />
            <StatCard
              icon={Activity}
              tone="success"
              label={t("overview.requests")}
              value={format.number(overview.requests7d, "integer")}
            />
            <StatCard
              icon={AlertTriangle}
              tone={overview.errors7d > 0 ? "danger" : "neutral"}
              label={t("overview.errors")}
              value={format.number(overview.errors7d, "integer")}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SearchField
              value={query}
              onChange={setQuery}
              aria-label={t("searchPlaceholder")}
              className="w-full max-w-sm"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("searchPlaceholder")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
            {createButton}
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={KeyRound} title={t("noMatches")} />
          ) : (
            <>
              <RowCards label={t("title")}>
                {filtered.map((row) => {
                  const bound = binding(row);
                  return (
                    <RowCard
                      key={row.token_id}
                      title={row.key_alias || tCommon("none")}
                      description={<span className="font-mono text-xs">{row.key_name}…</span>}
                      chips={keyChips(row)}
                      details={[
                        {
                          label: t("columns.binding"),
                          value: (
                            <>
                              {bound.name}
                              <span className="block text-xs text-muted">{bound.path}</span>
                            </>
                          ),
                          wide: true,
                        },
                        { label: t("columns.access"), value: accessLabel(row) },
                        { label: t("columns.spend"), value: spendLabel(row) },
                      ]}
                      actions={keyActions(row)}
                    />
                  );
                })}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
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
                            <Table.Cell>{spendLabel(row)}</Table.Cell>
                            <Table.Cell>
                              <div className="flex flex-wrap gap-1">{keyChips(row)}</div>
                            </Table.Cell>
                            <Table.Cell>
                              <div className="flex gap-1">{keyActions(row)}</div>
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
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
      <KeyMcpDialog
        key={`mcp-${dialogKey}`}
        state={mcpState}
        keyId={mcpKey?.token_id ?? null}
        keyName={mcpKey ? mcpKey.key_alias || mcpKey.key_name : ""}
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
