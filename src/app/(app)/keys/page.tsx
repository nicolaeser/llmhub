"use client";

import { useState, useTransition } from "react";
import { Button, useOverlayState } from "@heroui/react";
import { Activity, AlertTriangle, CircleDollarSign, KeyRound, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import type { KeyMenuAction } from "./_components/key-menu";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { useRouter } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { isActionFail } from "@/lib/http/action-result";
import { keyState } from "@/lib/keys/pause";
import type { KeyOptions, VirtualKeyView } from "@/types/keys";
import type { BudgetDetail, BudgetResult } from "@/types/structure";
import { useConsoleScope } from "../_components/console-scope";
import GettingStarted from "./_components/getting-started";
import KeyList from "./_components/key-list";
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
} from "./_action";

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
  setBudget: setBudgetAction,
};

export default function KeysPage() {
  const t = useTranslations("Keys");
  const format = useFormatter();
  const showError = useErrorToast();
  const router = useRouter();
  const scope = useConsoleScope();
  const now = useClock(60_000);
  const [budgetFor, setBudgetFor] = useState<(BudgetDetail & { alias: string }) | null>(null);
  const [loadingBudget, setLoadingBudget] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [, startBudget] = useTransition();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const page = useActionData(loadKeysPageAction);
  const { data, setData } = page;
  const options: KeyOptions | null = data
    ? {
        companyId: data.companyId,
        orgs: data.orgs,
        teams: data.teams,
        projects: data.projects,
        members: data.members,
        models: data.models,
        templates: data.templates,
        canTemplates: data.canTemplates,
      }
    : null;
  const keyDialogs = useKeyDialogs({
    actions: KEY_ACTIONS,
    canBind: data?.canBind ?? false,
    canBudget: data?.canBudget ?? false,
    onSaved: upsertKey,
    onRevoked: (id) => setKeys((current) => current.filter((row) => row.token_id !== id)),
  });

  function setKeys(update: (current: VirtualKeyView[]) => VirtualKeyView[]) {
    setData((current) => ({ ...current, keys: update(current.keys) }));
  }

  function upsertKey(row: VirtualKeyView) {
    setKeys((current) =>
      current.some((item) => item.token_id === row.token_id)
        ? current.map((item) => (item.token_id === row.token_id ? row : item))
        : [row, ...current],
    );
  }

  function applyBudget(result: BudgetResult) {
    setKeys((current) =>
      current.map((row) =>
        row.token_id === result.id
          ? {
              ...row,
              max_budget: result.budget.maxBudget,
              spend: result.budget.spend,
              budget_duration: result.budget.budgetDuration,
            }
          : row,
      ),
    );
    setBudgetFor((current) => (current?.id === result.id ? { ...current, budget: result.budget } : current));
  }

  function openBudget(row: VirtualKeyView, dialog: BudgetDialogKind) {
    setLoadingBudget(row.token_id);
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

  function runMenu(row: VirtualKeyView, action: KeyMenuAction) {
    const target = { id: row.token_id, name: row.key_alias || row.key_name };
    if (action === "edit") router.push(`/keys/${row.token_id}`);
    if (action === "pause") keyDialogs.askPause(target);
    if (action === "resume") keyDialogs.resume(target);
    if (action === "mcp") keyDialogs.openMcp(target);
    if (action === "budget" || action === "boost") openBudget(row, action);
    if (action === "rotate") keyDialogs.askRotate(target);
    if (action === "revoke") keyDialogs.askRevoke(target);
  }

  if (!data || !options) {
    return <PageStatus icon={KeyRound} title={t("title")} subtitle={t("subtitle")} state={page} stats={4} />;
  }

  const { canManage, canBudget, canMcp, overview } = data;
  const openCreate = () => keyDialogs.openCreate(options, null);
  const createButton = canManage ? (
    <Button onPress={openCreate}>
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  ) : undefined;
  const setupIncomplete =
    canManage &&
    scope.kind === "platform" &&
    (data.providers === 0 || options.models.length === 0 || data.keys.length === 0);
  const blockedOrPaused = data.keys.filter(
    (row) => keyState({ blocked: row.blocked, paused: row.paused, pausedUntil: row.paused_until }, now) !== "active",
  ).length;

  return (
    <div>
      <PageHeader icon={KeyRound} title={t("title")} subtitle={t("subtitle")} actions={createButton} />
      <div className="space-y-5">
        {setupIncomplete ? (
          <GettingStarted
            providers={data.providers}
            models={options.models.length}
            keys={data.keys.length}
            links={data.setupLinks}
            onCreateKey={openCreate}
          />
        ) : null}

        {data.keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t("emptyTitle")}
            description={t("empty", { canManage: canManage ? "yes" : "no" })}
            action={createButton}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                icon={KeyRound}
                label={t("overview.keys")}
                value={format.number(data.keys.length, "integer")}
                hint={blockedOrPaused ? t("overview.inactive", { count: blockedOrPaused }) : undefined}
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
                    tone={overview.requests7d > 0 ? "success" : "neutral"}
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
            <KeyList
              keys={data.keys}
              options={options}
              owners={data.owners}
              flags={{ canManage, canMcp, canBudget }}
              now={now}
              busyId={loadingBudget ?? keyDialogs.busy?.id ?? null}
              lockedId={loadingBudget}
              onAction={runMenu}
            />
          </>
        )}
      </div>

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
