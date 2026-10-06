"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Chip,
  SearchField,
  Spinner,
  Table,
  toast,
  useOverlayState,
} from "@heroui/react";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BudgetDialog from "@/components/budget/budget-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import StatCard from "@/components/console/stat-card";
import GettingStarted from "@/app/(app)/_components/getting-started";
import { KeyDialog } from "@/app/(app)/_components/key-dialog";
import { loadKeysPageAction, revokeKeyAction, rotateKeyAction } from "@/app/(app)/_action";
import { setBudgetAction } from "@/app/(app)/structure/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { VirtualKeyView } from "@/types/gateway";
import type { KeyOptions } from "@/types/keys";
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
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<VirtualKeyView[]>([]);
  const [teams, setTeams] = useState<KeyOptions["teams"]>([]);
  const [projects, setProjects] = useState<KeyOptions["projects"]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [templates, setTemplates] = useState<KeyOptions["templates"]>([]);
  const [providerCount, setProviderCount] = useState(0);
  const [canBudget, setCanBudget] = useState(false);
  const [budgetKey, setBudgetKey] = useState<VirtualKeyView | null>(null);
  const [overview, setOverview] = useState({
    spend7d: 0,
    requests7d: 0,
    errors7d: 0,
  });
  const [query, setQuery] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<VirtualKeyView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busy, setBusy] = useState<{ id: string; action: "rotate" | "revoke" } | null>(null);
  const [, start] = useTransition();
  const dialogState = useOverlayState();
  const budgetState = useOverlayState();

  function openDialog(row: VirtualKeyView | null) {
    setEditing(row);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  function openBudget(row: VirtualKeyView) {
    setBudgetKey(row);
    setDialogKey((n) => n + 1);
    budgetState.open();
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
        toast.danger(tError("code", { code: result.error }));
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
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setKeys((current) => current.filter((k) => k.token_id !== result.id));
      toast(t("toasts.revoked"), { variant: "success" });
    });
  }

  useEffect(() => {
    loadKeysPageAction().then((res) => {
      if (!isActionFail(res)) {
        setKeys(res.keys);
        setTeams(res.teams);
        setProjects(res.projects);
        setAliases(res.models);
        setTemplates(res.templates);
        setProviderCount(res.providers);
        setCanBudget(res.canBudget);
        setOverview(res.overview);
      }
      setLoading(false);
    });
  }, []);

  function accessLabel(row: VirtualKeyView): string {
    if (!row.templates.length && !row.models.length) return t("allModels");
    const names = templates.filter((template) => row.templates.includes(template.id)).map((template) => template.name);
    return format.list(
      row.models.length ? [...names, t("modelCount", { count: row.models.length })] : names,
      { type: "unit" },
    );
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return keys.filter(
      (k) =>
        !q ||
        k.key_alias.toLowerCase().includes(q) ||
        k.key_name.toLowerCase().includes(q) ||
        k.token_id.toLowerCase().includes(q),
    );
  }, [keys, query]);

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

  const createButton = (
    <Button
      aria-label={t("create")}
      onPress={() => openDialog(null)}
    >
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  );
  const setupIncomplete =
    providerCount === 0 || aliases.length === 0 || keys.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={keys.length ? createButton : undefined}
      />

      {setupIncomplete ? (
        <GettingStarted
          providers={providerCount}
          models={aliases.length}
          keys={keys.length}
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

      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={t("emptyTitle")}
          description={t("empty")}
          action={createButton}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t("overview.keys")} value={format.number(keys.length, "integer")} />
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
                    <Table.Column>{t("columns.secret")}</Table.Column>
                    <Table.Column>{t("columns.access")}</Table.Column>
                    <Table.Column>{t("columns.spend")}</Table.Column>
                    <Table.Column>{t("columns.status")}</Table.Column>
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filtered.map((row) => (
                      <Table.Row key={row.token_id} id={row.token_id}>
                        <Table.Cell>
                          <div className="font-medium">{row.key_alias || tCommon("none")}</div>
                          <div className="font-mono text-xs text-muted">
                            {row.token_id}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs">{row.key_name}…</span>
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
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex gap-1">
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("edit")}
                              onPress={() => openDialog(row)}
                            >
                              <Pencil size={14} aria-hidden />
                            </Button>
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
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("rotate")}
                              isPending={busy?.id === row.token_id && busy.action === "rotate"}
                              isDisabled={busy !== null && busy.id !== row.token_id}
                              onPress={() => rotate(row.token_id)}
                            >
                              <RefreshCw size={14} aria-hidden />
                            </Button>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="danger-soft"
                              aria-label={t("revoke")}
                              isPending={busy?.id === row.token_id && busy.action === "revoke"}
                              isDisabled={busy !== null && busy.id !== row.token_id}
                              onPress={() => revoke(row.token_id)}
                            >
                              <Trash2 size={14} aria-hidden />
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
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
        options={{ teams, projects, models: aliases, templates }}
        onSaved={(row, created) => {
          upsertKey(row);
          if (created) setSecret(created);
        }}
      />
    </div>
  );
}
