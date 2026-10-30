"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Dropdown, toast, useOverlayState } from "@heroui/react";
import { ArrowRightLeft, BarChart3, Building2, ChevronDown, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import type { PageBackLink } from "@/components/console/page-header";
import PageHeader from "@/components/console/page-header";
import PageStatus, { PageLoading } from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { useRouter } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { companyAlias, companyHref, companyTabOf } from "@/lib/tenancy/company-view";
import { usageHref } from "@/lib/usage/usage-query";
import type { KeyChoices, KeyPreset } from "@/types/keys";
import type { PolicyOverrideSummary } from "@/types/guardrails";
import type {
  BudgetResult,
  BudgetTarget,
  CompanyTab,
  SetupStep,
  StructurePayload,
  TenancyKind,
} from "@/types/structure";
import { useConsoleScope } from "../../_components/console-scope";
import {
  addBoostAction,
  createKeyAction,
  deleteCompanyAction,
  deleteNodeAction,
  loadCompanyAction,
  loadCompanyMcpAction,
  loadCompanyPoliciesAction,
  loadKeyMcpAccessAction,
  loadKeyOptionsAction,
  pauseKeyAction,
  removeBoostAction,
  resumeKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  saveCompanyMcpInstallationAction,
  saveKeyMcpAccessAction,
  setBudgetAction,
  updateKeyAction,
} from "../_action";
import AccessTab from "./access-tab";
import { keyOptionsOf, withKey, withoutKey } from "./key-model";
import KeysTab from "./keys-tab";
import LabelKeysCard from "./label-keys-card";
import McpConnectionsCard from "./mcp-connections-card";
import NodeDialog from "./node-dialog";
import OverviewTab from "./overview-tab";
import PeopleTab from "./people-tab";
import ReportsCard from "./reports-card";
import StructureTab from "./structure-tab";
import {
  accessUsersOf,
  budgetOf,
  chainOf,
  nodeIn,
  parseNodeRef,
  setupStepsFor,
  usageFilterOf,
  withBudget,
  type NodeAction,
} from "./tree-model";

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

type HeaderAction = "edit" | "switch" | "usage" | "delete";

type NodeForm = { kind: TenancyKind; editingId: string | null; teamId: string };

type PlacedRef = { kind: Exclude<TenancyKind, "org">; id: string; alias: string };

type Removal = { kind: "org"; id: string; alias: string } | PlacedRef;

export default function CompanyDetail({ orgId, back }: { orgId: string; back?: PageBackLink }) {
  const t = useTranslations("Companies");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const router = useRouter();
  const consoleScope = useConsoleScope();
  const nodeParam = useSearchParam("node");
  const tabParam = useSearchParam("tab");
  const [nodeForm, setNodeForm] = useState<NodeForm>({ kind: "team", editingId: null, teamId: "" });
  const [budgetTarget, setBudgetTarget] = useState<BudgetTarget | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [keyChoices, setKeyChoices] = useState<KeyChoices | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [creatingKey, setCreatingKey] = useState(false);
  const [deleting, startDelete] = useTransition();
  const [, startKey] = useTransition();
  const nodeState = useOverlayState();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const deleteState = useOverlayState();
  const page = useActionData(() => loadCompanyAction(orgId));
  const { data, setData } = page;
  const keyDialogs = useKeyDialogs({
    actions: KEY_ACTIONS,
    canBind: data?.canManage ?? false,
    canBudget: data?.canBudget ?? false,
    onSaved: (key) => setData((current) => withKey(current, key)),
    onRevoked: (id) => setData((current) => withoutKey(current, id)),
  });
  const focus = data ? parseNodeRef(nodeParam) : null;
  const loaded = data !== null;

  useEffect(() => {
    const requested = loaded ? parseNodeRef(nodeParam) : null;
    if (!requested) return;
    if (requested.kind === "org") {
      setSearchParams({ node: null });
      return;
    }
    const tab = companyTabOf(requested);
    if (requested.kind === "key") router.replace(`/keys/${encodeURIComponent(requested.id)}`);
    else if (!tabParam && tab) setSearchParams({ tab });
  }, [loaded, nodeParam, tabParam, router]);

  const knownAlias = companyAlias(consoleScope, orgId);

  if (!data) {
    if (!knownAlias && page.error === null) return <PageLoading header tabs stats={4} layout="panels" />;
    return (
      <PageStatus
        icon={Building2}
        title={knownAlias ?? t("detail.fallbackTitle")}
        back={back}
        state={page}
        tabs
        stats={4}
        layout="panels"
      />
    );
  }

  const org = data.orgs[0];
  if (!org) return null;
  const isPlatform = !data.companyId;
  const flags = {
    canManage: data.canManage,
    canBudget: data.canBudget,
    canCreateKeys: data.canCreateKeys,
    canSeeUsage: data.canSeeUsage,
  };
  const canBudgetOrg = data.canBudget && isPlatform;
  const steps = setupStepsFor({ company: true, canBudget: data.canBudget });
  const accessUsers = accessUsersOf(data, org.id);
  const shownFocus = focus && nodeIn(data, focus) ? focus : null;
  const budgetFor = budgetTarget ? budgetOf(data, budgetTarget.kind, budgetTarget.id) : null;
  const headerActions: HeaderAction[] = [
    ...(data.canManage && isPlatform ? (["edit"] as const) : []),
    ...(isPlatform && consoleScope.canSwitch ? (["switch"] as const) : []),
    ...(data.canSeeUsage ? (["usage"] as const) : []),
    ...(data.canManage && isPlatform ? (["delete"] as const) : []),
  ];

  function openNode(kind: TenancyKind, editingId: string | null, teamId = "") {
    setNodeForm({ kind, editingId, teamId });
    setDialogKey((n) => n + 1);
    nodeState.open();
  }

  function openBudget(target: BudgetTarget, dialog: "budget" | "boost") {
    setBudgetTarget(target);
    setDialogKey((n) => n + 1);
    (dialog === "budget" ? budgetState : boostState).open();
  }

  function askDelete(target: Removal) {
    setRemoval(target);
    deleteState.open();
  }

  function applyBudget(result: BudgetResult) {
    setData((current) => withBudget(current, result.kind, result.id, result.budget));
  }

  function createKey(preset: KeyPreset | null) {
    setCreatingKey(true);
    startKey(async () => {
      const choices = keyChoices ?? (await loadKeyOptionsAction());
      setCreatingKey(false);
      if (isActionFail(choices)) {
        showError(choices.error);
        return;
      }
      setKeyChoices(choices);
      if (data) keyDialogs.openCreate(keyOptionsOf(data, choices), preset);
    });
  }

  function onNodeAction(ref: PlacedRef, action: NodeAction) {
    if (action === "edit") openNode(ref.kind, ref.id);
    if (action === "budget" || action === "boost") openBudget({ kind: ref.kind, id: ref.id, alias: ref.alias }, action);
    if (action === "addProject") openNode("project", null, ref.id);
    if (action === "createKey" && ref.kind !== "team") createKey({ kind: ref.kind, id: ref.id });
    if (action === "usage") router.push(usageHref(usageFilterOf(ref, isPlatform)));
    if (action === "delete") askDelete(ref);
  }

  function onHeaderAction(action: HeaderAction) {
    if (action === "edit" && org) openNode("org", org.id);
    if (action === "switch" && org) consoleScope.switchTo(org.id);
    if (action === "usage" && org) router.push(usageHref(usageFilterOf({ kind: "org", id: org.id }, isPlatform)));
    if (action === "delete" && org) askDelete({ kind: "org", id: org.id, alias: org.alias });
  }

  function onStep(step: SetupStep) {
    if (step === "team" || step === "project" || step === "member") openNode(step, null);
    if (step === "budget" && org) {
      const row = canBudgetOrg ? org : data?.teams[0];
      if (row) openBudget({ kind: canBudgetOrg ? "org" : "team", id: row.id, alias: row.alias }, "budget");
    }
  }

  function showTab(tab: CompanyTab) {
    setSearchParams({ tab: tab === "overview" ? null : tab, node: null });
  }

  function remove(target: Removal) {
    startDelete(async () => {
      if (target.kind === "org") {
        const result = await deleteCompanyAction(target.id);
        if (isActionFail(result)) {
          showError(result.error);
          return;
        }
        toast(t("detail.deleted", { kind: "org" }), { variant: "success" });
        consoleScope.refresh();
        router.push("/companies");
        return;
      }
      const result = await deleteNodeAction({ kind: target.kind, id: target.id, orgId });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      toast(t("detail.deleted", { kind: target.kind }), { variant: "success" });
    });
  }

  function overrideHref(row: PolicyOverrideSummary): string | null {
    if (row.scope === "key") return `/keys/${encodeURIComponent(row.id)}`;
    if (row.scope !== "team" && row.scope !== "project") return null;
    const ref = { kind: row.scope, id: row.id };
    if (!data || !nodeIn(data, ref)) return null;
    return companyHref({ orgId, tab: "structure", node: ref }, isPlatform);
  }

  const tabs = [
    {
      id: "overview",
      label: t("tabs", { tab: "overview" }),
      panel: (
        <OverviewTab
          data={data}
          steps={steps}
          canBudget={canBudgetOrg}
          onStep={onStep}
          onBudget={() => openBudget({ kind: "org", id: org.id, alias: org.alias }, "budget")}
          onBoost={() => openBudget({ kind: "org", id: org.id, alias: org.alias }, "boost")}
          onTab={showTab}
        />
      ),
    },
    {
      id: "structure",
      label: t("tabs", { tab: "structure" }),
      panel: (
        <StructureTab
          data={data}
          flags={flags}
          focus={shownFocus}
          onAdd={(kind, teamId) => openNode(kind, null, teamId)}
          onAction={onNodeAction}
        />
      ),
    },
    {
      id: "people",
      label: t("tabs", { tab: "people" }),
      panel: (
        <PeopleTab
          data={data}
          flags={flags}
          focus={shownFocus}
          onAdd={() => openNode("member", null)}
          onAction={onNodeAction}
        />
      ),
    },
    ...(data.canSeeKeys
      ? [
          {
            id: "keys",
            label: t("tabs", { tab: "keys" }),
            panel: (
              <KeysTab
                data={data}
                creating={creatingKey}
                onCreate={data.canCreateKeys ? () => createKey(null) : null}
              />
            ),
          },
        ]
      : []),
    ...(accessUsers || data.canSeePolicies
      ? [
          {
            id: "access",
            label: t("tabs", { tab: "access" }),
            panel: (
              <AccessTab
                orgId={org.id}
                users={accessUsers}
                loadPolicies={data.canSeePolicies ? loadCompanyPoliciesAction : null}
                hrefOf={overrideHref}
              />
            ),
          },
        ]
      : []),
    ...(data.canSeeMcp
      ? [
          {
            id: "integrations",
            label: t("tabs", { tab: "integrations" }),
            panel: (
              <McpConnectionsCard
                orgId={org.id}
                load={loadCompanyMcpAction}
                onInstall={saveCompanyMcpInstallationAction}
              />
            ),
          },
        ]
      : []),
    {
      id: "reports",
      label: t("tabs", { tab: data.canSeeReports ? "reports" : "labels" }),
      panel: (
        <div className="space-y-5">
          {data.canSeeReports ? (
            <ReportsCard
              company={{ id: org.id, alias: org.alias }}
              departments={data.teams.map((row) => ({ id: row.id, alias: row.alias }))}
              reports={data.reports}
              people={data.members}
              canReport={data.canReport}
              mailEnabled={data.mailEnabled}
              onChange={(reports) =>
                setData((current) => ({ ...current, reports: reports.filter((row) => row.orgId === orgId) }))
              }
            />
          ) : null}
          <LabelKeysCard
            orgId={org.id}
            keys={org.labelKeys}
            inherited={data.platformLabelKeys}
            canManage={data.canManage}
            onSaved={(payload: StructurePayload) => setData(payload)}
          />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Building2}
        back={back}
        title={org.alias}
        subtitle={t("detail.subtitle", {
          scope: isPlatform ? "platform" : "company",
          teams: data.teams.length,
          projects: data.projects.length,
          members: data.members.length,
        })}
        actions={
          headerActions.length ? (
            <Dropdown>
              <Button variant="secondary" isPending={consoleScope.pending || deleting}>
                {t("detail.actions")}
                <ChevronDown size={14} aria-hidden />
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label={t("detail.actions")}
                  onAction={(key) => {
                    const action = headerActions.find((item) => item === key);
                    if (action) onHeaderAction(action);
                  }}
                >
                  {headerActions.map((action) => {
                    const Icon =
                      action === "edit"
                        ? Pencil
                        : action === "switch"
                          ? ArrowRightLeft
                          : action === "usage"
                            ? BarChart3
                            : Trash2;
                    return (
                      <Dropdown.Item
                        key={action}
                        id={action}
                        textValue={t("detail.action", { action })}
                        variant={action === "delete" ? "danger" : "default"}
                      >
                        <Icon size={14} aria-hidden />
                        {t("detail.action", { action })}
                      </Dropdown.Item>
                    );
                  })}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : undefined
        }
      />

      <PageTabs label={org.alias} tabs={tabs} />

      <NodeDialog
        key={`node-${dialogKey}`}
        state={nodeState}
        kind={nodeForm.kind}
        editingId={nodeForm.editingId}
        orgId={org.id}
        teamId={nodeForm.teamId}
        data={data}
        onSaved={(payload) => {
          setData(payload);
          if (nodeForm.kind === "org") consoleScope.refresh();
        }}
      />
      <BudgetDialog
        key={`budget-${dialogKey}`}
        state={budgetState}
        target={budgetTarget}
        budget={budgetFor}
        ancestors={budgetTarget ? chainOf(data, budgetTarget.kind, budgetTarget.id).slice(1) : []}
        onSubmit={setBudgetAction}
        onSaved={applyBudget}
      />
      <BoostDialog
        key={`boost-${dialogKey}`}
        state={boostState}
        target={budgetTarget}
        budget={budgetFor}
        onSubmit={addBoostAction}
        onRemove={removeBoostAction}
        onSaved={applyBudget}
      />
      <ConfirmDialog
        state={deleteState}
        title={t("detail.deleteTitle", { kind: removal?.kind ?? "other", alias: removal?.alias ?? "" })}
        description={t("detail.deleteHint", { kind: removal?.kind ?? "other" })}
        confirmLabel={tCommon("delete")}
        cancelLabel={tCommon("cancel")}
        pending={deleting}
        onConfirm={() => {
          if (removal) remove(removal);
        }}
      />
      {keyDialogs.dialogs}
    </div>
  );
}
