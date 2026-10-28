"use client";

import { useMemo, useState, useTransition } from "react";
import { Button, Chip, SearchField, Table, useOverlayState } from "@heroui/react";
import { Activity, AlertTriangle, CircleDollarSign, KeyRound, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import { bindingKind, placeOf } from "@/components/keys/key-binding";
import KeyMenu, { hasKeyMenu, keyMenuActions, type KeyMenuAction } from "@/components/keys/key-menu";
import KeyStateChip from "@/components/keys/key-state-chip";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { useConsoleScope } from "../../_components/console-scope";
import GettingStarted from "./getting-started";
import {
  addBoostAction,
  createKeyAction,
  loadBudgetAction,
  loadKeyMcpAccessAction,
  loadKeysPageAction,
  pauseKeyAction,
  removeBoostAction,
  resumeKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  saveKeyMcpAccessAction,
  setBudgetAction,
  updateKeyAction,
} from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { isKeyPaused, keyState } from "@/lib/keys/pause";
import { isActionFail } from "@/lib/http/action-result";
import type { KeyOptions, VirtualKeyView } from "@/types/keys";
import type { BudgetDetail, BudgetResult } from "@/types/structure";

type BudgetDialogKind = "budget" | "boost";

const KEY_ACTIONS: KeyServerActions = {
  create: createKeyAction,
  update: updateKeyAction,
  pause: pauseKeyAction,
  resume: resumeKeyAction,
  rotate: rotateKeyAction,
  revoke: revokeKeyAction,
  loadMcp: loadKeyMcpAccessAction,
  saveMcp: saveKeyMcpAccessAction,
};

export default function KeysTab() {
  const t = useTranslations("Keys");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useClock(60_000);
  const scope = useConsoleScope();
  const [budgetFor, setBudgetFor] = useState<(BudgetDetail & { alias: string }) | null>(null);
  const [loadingBudget, setLoadingBudget] = useState<{ id: string; dialog: BudgetDialogKind } | null>(null);
  const [query, setQuery] = useState("");
  const [dialogKey, setDialogKey] = useState(0);
  const [, startBudget] = useTransition();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const page = useActionData(loadKeysPageAction);
  const { data, setData } = page;
  const keys = data?.keys;
  const keyDialogs = useKeyDialogs({
    actions: KEY_ACTIONS,
    canBind: data?.canBind ?? false,
    onSaved: (row) => upsertKey(row),
    onRevoked: (id) => setKeys((current) => current.filter((k) => k.token_id !== id)),
  });

  function openBudget(row: VirtualKeyView, dialog: BudgetDialogKind) {
    setLoadingBudget({ id: row.token_id, dialog });
    startBudget(async () => {
      const result = await loadBudgetAction({ kind: "key", id: row.token_id });
      setLoadingBudget(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setBudgetFor({ ...result, alias: row.key_alias || row.key_name });
      setDialogKey((n) => n + 1);
      if (dialog === "budget") budgetState.open();
      else boostState.open();
    });
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
    setBudgetFor((current) => (current?.id === result.id ? { ...current, budget: result.budget } : current));
  }

  function upsertKey(row: VirtualKeyView) {
    setKeys((current) =>
      current.some((k) => k.token_id === row.token_id)
        ? current.map((k) => (k.token_id === row.token_id ? row : k))
        : [row, ...current],
    );
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

  const { canManage, canBudget, canMcp, canOpenCompanies, overview, owners } = data;
  const menuFlags = { canManage, canMcp, canBudget };
  const hasActions = hasKeyMenu(menuFlags);
  const options: KeyOptions = {
    companyId: data.companyId,
    orgs: data.orgs,
    teams: data.teams,
    projects: data.projects,
    members: data.members,
    models: data.models,
    templates: data.templates,
    canTemplates: data.canTemplates,
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

  function pauseOf(row: VirtualKeyView) {
    return { blocked: row.blocked, paused: row.paused, pausedUntil: row.paused_until };
  }

  function keyChips(row: VirtualKeyView) {
    return (
      <>
        <KeyStateChip state={keyState(pauseOf(row), now)} pausedUntil={row.paused_until} />
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

  function keyTitle(row: VirtualKeyView) {
    const name = row.key_alias || tCommon("none");
    if (!canOpenCompanies || !row.org_id) return name;
    return (
      <Link href={`/companies?node=key:${row.token_id}`} className="text-accent">
        {name}
      </Link>
    );
  }

  function runMenu(row: VirtualKeyView, action: KeyMenuAction) {
    const target = { id: row.token_id, name: row.key_alias || row.key_name };
    if (action === "edit") keyDialogs.openEdit(options, row);
    if (action === "pause") keyDialogs.askPause(target);
    if (action === "resume") keyDialogs.resume(target);
    if (action === "mcp") keyDialogs.openMcp(target);
    if (action === "budget" || action === "boost") openBudget(row, action);
    if (action === "rotate") keyDialogs.askRotate(target);
    if (action === "revoke") keyDialogs.askRevoke(target);
  }

  function keyMenu(row: VirtualKeyView) {
    return (
      <KeyMenu
        name={row.key_alias || row.key_name}
        actions={keyMenuActions(menuFlags, { capped: row.max_budget > 0, paused: isKeyPaused(pauseOf(row), now) })}
        pending={loadingBudget?.id === row.token_id || keyDialogs.busy?.id === row.token_id}
        isDisabled={loadingBudget !== null && loadingBudget.id !== row.token_id}
        onAction={(action) => runMenu(row, action)}
      />
    );
  }

  const createButton = canManage ? (
    <Button onPress={() => keyDialogs.openCreate(options, null)}>
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
          links={data.setupLinks}
          onCreateKey={() => keyDialogs.openCreate(options, null)}
        />
      ) : null}

      {keyDialogs.notice}

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
            {overview ? (
              <>
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
              </>
            ) : null}
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
                      title={keyTitle(row)}
                      description={<span className="font-mono text-xs">{row.key_name}…</span>}
                      aside={hasActions ? keyMenu(row) : undefined}
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
                      {hasActions ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                    </Table.Header>
                    <Table.Body>
                      {filtered.map((row) => {
                        const bound = binding(row);
                        return (
                          <Table.Row key={row.token_id} id={row.token_id}>
                            <Table.Cell>
                              <div className="font-medium">{keyTitle(row)}</div>
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
                            {hasActions ? <Table.Cell>{keyMenu(row)}</Table.Cell> : null}
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
        target={budgetFor}
        budget={budgetFor?.budget ?? null}
        ancestors={budgetFor?.ancestors ?? []}
        onSubmit={setBudgetAction}
        onSaved={applyBudget}
      />
      <BoostDialog
        key={`boost-${dialogKey}`}
        state={boostState}
        target={budgetFor}
        budget={budgetFor?.budget ?? null}
        onSubmit={addBoostAction}
        onRemove={removeBoostAction}
        onSaved={applyBudget}
      />
      {keyDialogs.dialogs}
    </div>
  );
}
