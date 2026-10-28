"use client";

import { useRef, useState, useTransition } from "react";
import { Button, Card, Spinner, toast, useOverlayState } from "@heroui/react";
import {
  ArrowRightLeft,
  Building2,
  Folder,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import type { KeyServerActions } from "@/components/keys/use-key-dialogs";
import { useActionData } from "@/lib/hooks/use-action-data";
import { BELOW_LG, REDUCED_MOTION } from "@/lib/hooks/use-media-query";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { usageHref } from "@/lib/usage/usage-query";
import type { KeyChoices, VirtualKeyView } from "@/types/keys";
import type {
  BudgetResult,
  BudgetTarget,
  NodeKind,
  NodeRef,
  SetupStep,
  StructurePayload,
  TenancyKind,
  TenancyRef,
} from "@/types/structure";
import {
  addBoostAction,
  createKeyAction,
  deleteNodeAction,
  loadCompanyMcpAction,
  loadCompanyPoliciesAction,
  loadKeyDetailAction,
  loadKeyMcpAccessAction,
  loadKeyOptionsAction,
  loadStructureAction,
  pauseKeyAction,
  removeBoostAction,
  resumeKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  saveCompanyMcpInstallationAction,
  saveKeyMcpAccessAction,
  setBudgetAction,
  updateKeyAction,
} from "./_action";
import AccessCard from "./_components/access-card";
import BudgetCard from "./_components/budget-card";
import ChildrenCard from "./_components/children-card";
import CompanyTree from "./_components/company-tree";
import InsightLinks from "./_components/insight-links";
import LabelKeysCard from "./_components/label-keys-card";
import KeyPane from "./_components/key-pane";
import KeysCard from "./_components/keys-card";
import { keyPresetOf, withKey, withoutKey } from "./_components/key-model";
import McpConnectionsCard from "./_components/mcp-connections-card";
import MembersCard from "./_components/members-card";
import NodeDialog from "./_components/node-dialog";
import NodeHeader from "./_components/node-header";
import ReportsCard from "./_components/reports-card";
import SetupSteps, { setupDone } from "./_components/setup-steps";
import {
  accessUsersOf,
  budgetOf,
  chainOf,
  nodeExists,
  nodeKey,
  nodePath,
  parentOf,
  parseNodeRef,
  setupStepsFor,
  usageFilterOf,
  withBudget,
} from "./_components/tree-model";
import { useConsoleScope } from "../_components/console-scope";

const NODE_ICONS: Record<NodeKind, LucideIcon> = {
  org: Building2,
  team: Users,
  project: Folder,
  member: User,
  key: KeyRound,
};

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

function firstNode(data: StructurePayload): NodeRef | null {
  return data.orgs[0] ? { kind: "org", id: data.orgs[0].id } : null;
}

export default function CompaniesPage() {
  const t = useTranslations("Companies");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const format = useFormatter();
  const nodeParam = useSearchParam("node");
  const [nodeForm, setNodeForm] = useState<{
    kind: TenancyKind;
    editingId: string | null;
    orgId: string;
    teamId: string;
  }>({ kind: "org", editingId: null, orgId: "", teamId: "" });
  const [budgetTarget, setBudgetTarget] = useState<BudgetTarget | null>(null);
  const [keyChoices, setKeyChoices] = useState<KeyChoices | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, startDelete] = useTransition();
  const detailRef = useRef<HTMLDivElement>(null);
  const nodeState = useOverlayState();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const page = useActionData(loadStructureAction);
  const { data, setData } = page;
  const consoleScope = useConsoleScope();

  function select(ref: NodeRef | null) {
    setSearchParams({ node: ref ? nodeKey(ref) : null });
  }

  function revealDetail() {
    detailRef.current?.scrollIntoView({
      behavior: window.matchMedia(REDUCED_MOTION).matches ? "auto" : "smooth",
      block: "start",
    });
  }

  function selectFromTree(ref: NodeRef) {
    select(ref);
    if (window.matchMedia(BELOW_LG).matches) revealDetail();
  }

  function selectInPane(ref: NodeRef) {
    select(ref);
    if ((detailRef.current?.getBoundingClientRect().top ?? 0) < 0) revealDetail();
  }

  function openNode(kind: TenancyKind, editingId: string | null, orgId: string, teamId = "") {
    setNodeForm({ kind, editingId, orgId, teamId });
    setDialogKey((n) => n + 1);
    nodeState.open();
  }

  function openBudget(target: BudgetTarget, state: ReturnType<typeof useOverlayState>) {
    setBudgetTarget(target);
    setDialogKey((n) => n + 1);
    state.open();
  }

  function openKeyBudget(target: BudgetTarget, dialog: "budget" | "boost") {
    openBudget(target, dialog === "budget" ? budgetState : boostState);
  }

  function applyBudget(result: BudgetResult) {
    setData((current) => withBudget(current, result.kind, result.id, result.budget));
  }

  function applyKey(key: VirtualKeyView) {
    setData((current) => withKey(current, key));
  }

  function dropKey(id: string) {
    setData((current) => withoutKey(current, id));
  }

  async function loadChoices(): Promise<KeyChoices | null> {
    if (keyChoices) return keyChoices;
    const result = await loadKeyOptionsAction();
    if (isActionFail(result)) {
      showError(result.error);
      return null;
    }
    setKeyChoices(result);
    return result;
  }

  if (!data) {
    const loadingTitle = consoleScope.scope.kind === "company" ? consoleScope.scope.alias : t("title");
    return <PageStatus icon={Building2} title={loadingTitle} state={page} layout="split" />;
  }

  const platform = !data.companyId;
  const scope = platform ? "platform" : "company";
  const home = platform ? undefined : data.orgs.find((row) => row.id === data.companyId);
  const requested = parseNodeRef(nodeParam);
  const selected = requested && nodeExists(data, requested) ? requested : firstNode(data);
  const tenancy: TenancyRef | null =
    selected && selected.kind !== "key" ? { kind: selected.kind, id: selected.id } : null;
  const keyNode = selected?.kind === "key" ? data.keys.find((row) => row.id === selected.id) : undefined;
  const org = tenancy?.kind === "org" ? data.orgs.find((row) => row.id === tenancy.id) : undefined;
  const team = tenancy?.kind === "team" ? data.teams.find((row) => row.id === tenancy.id) : undefined;
  const project =
    tenancy?.kind === "project" ? data.projects.find((row) => row.id === tenancy.id) : undefined;
  const member =
    tenancy?.kind === "member" ? data.members.find((row) => row.id === tenancy.id) : undefined;
  const placed = team ?? project ?? member;
  const node = org ?? placed;
  const orgId = org?.id ?? placed?.orgId ?? "";
  const teamId = team?.id ?? project?.teamId ?? member?.teamId ?? "";
  const path = nodePath(data, selected);
  const projectsIn = (where: { orgId?: string; teamId?: string }) =>
    data.projects.filter(
      (row) => (!where.orgId || row.orgId === where.orgId) && (!where.teamId || row.teamId === where.teamId),
    );
  const membersIn = (where: { orgId?: string; teamId?: string }) =>
    data.members.filter(
      (row) => (!where.orgId || row.orgId === where.orgId) && (!where.teamId || row.teamId === where.teamId),
    );
  const keysOf = (kind: TenancyKind, id: string) =>
    data.keys.filter((key) =>
      kind === "org"
        ? key.orgId === id
        : kind === "team"
          ? key.teamId === id
          : kind === "project"
            ? key.projectId === id
            : key.memberId === id,
    );
  const teamAlias = (id: string) => data.teams.find((row) => row.id === id)?.alias ?? "";
  const done = setupDone(data);
  const steps = setupStepsFor({ company: !platform, canBudget: data.canBudget });
  const showSteps = data.canManage && steps.some((step) => !done[step]);
  const budgetFor = budgetTarget ? budgetOf(data, budgetTarget.kind, budgetTarget.id) : null;
  const canEditNode = data.canManage && (tenancy?.kind !== "org" || platform);
  const canBudgetNode = data.canBudget && (tenancy?.kind !== "org" || platform);
  const accessUsers = org ? accessUsersOf(data, org.id) : null;

  function onStep(step: SetupStep) {
    const target = orgId || data?.orgs[0]?.id || "";
    if (step === "org") openNode("org", null, "");
    if (step === "team") openNode("team", null, target);
    if (step === "project") openNode("project", null, target, team?.id ?? "");
    if (step === "member") openNode("member", null, target, team?.id ?? "");
    if (step === "budget" && data?.canBudget && data.orgs[0]) {
      const kind = platform ? "org" : data.teams[0] ? "team" : null;
      const row = kind === "org" ? data.orgs[0] : data.teams[0];
      if (kind && row) openBudget({ kind, id: row.id, alias: row.alias }, budgetState);
    }
  }

  function remove(ref: TenancyRef) {
    const parent = data ? parentOf(data, ref) : null;
    startDelete(async () => {
      const result = await deleteNodeAction(ref);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      if (ref.kind === "org") consoleScope.refresh();
      select(ref.kind === "org" ? null : parent);
      toast(t("detail.deleted", { kind: ref.kind }), { variant: "success" });
    });
  }

  function revokedKey(id: string) {
    const parent = data ? parentOf(data, { kind: "key", id }) : null;
    dropKey(id);
    select(parent);
  }

  const createOrg = data.canManage && platform ? () => openNode("org", null, "") : null;
  const openCompanyView = platform && org && consoleScope.canSwitch ? () => consoleScope.switchTo(org.id) : null;
  const summary = org
    ? t("detail.orgSummary", {
        teams: data.teams.filter((row) => row.orgId === org.id).length,
        projects: projectsIn({ orgId: org.id }).length,
        members: membersIn({ orgId: org.id }).length,
      })
    : team
      ? t("detail.teamSummary", {
          projects: projectsIn({ teamId: team.id }).length,
          members: membersIn({ teamId: team.id }).length,
        })
      : project
        ? t("detail.projectSummary", {
            hasTeam: project.teamId ? "yes" : "no",
            team: teamAlias(project.teamId),
            showKeys: data.canSeeKeys ? "yes" : "no",
            keys: keysOf("project", project.id).length,
          })
        : member
          ? t("detail.memberSummary", {
              hasTeam: member.teamId ? "yes" : "no",
              team: teamAlias(member.teamId),
              hasEmail: member.email ? "yes" : "no",
              email: member.email,
            })
          : "";

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Building2}
        title={home?.alias ?? t("title")}
        subtitle={t("subtitle", { scope })}
        actions={
          createOrg && (node || keyNode) ? (
            <Button onPress={createOrg}>
              <Plus size={16} aria-hidden />
              {t("createOrg")}
            </Button>
          ) : undefined
        }
      />

      {showSteps ? <SetupSteps data={data} company={home?.alias ?? null} steps={steps} onStep={onStep} /> : null}

      {!selected || (!node && !keyNode) ? (
        <EmptyState
          icon={Building2}
          title={t("emptyTitle")}
          description={t("empty", { scope })}
          action={
            createOrg ? (
              <Button onPress={createOrg}>
                <Plus size={16} aria-hidden />
                {t("createOrg")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <CompanyTree data={data} selected={selected} onSelect={selectFromTree} />
          </div>

          <div ref={detailRef} className="min-w-0 space-y-5">
            {keyNode ? (
              <KeyPane
                key={`key:${keyNode.id}`}
                data={data}
                node={keyNode}
                actions={KEY_ACTIONS}
                loadKey={loadKeyDetailAction}
                loadChoices={loadChoices}
                onOpen={selectInPane}
                onBudget={openKeyBudget}
                onChanged={applyKey}
                onRevoked={revokedKey}
              />
            ) : null}

            {node && tenancy ? (
              <>
                <NodeHeader
                  icon={NODE_ICONS[tenancy.kind]}
                  path={path}
                  title={node.alias}
                  subtitle={`${t("detail.kind", { kind: tenancy.kind })} · ${summary}`}
                  onOpen={selectInPane}
                  actions={
                    canEditNode || openCompanyView || data.canSeeUsage ? (
                      <>
                        {openCompanyView ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            isPending={consoleScope.pending}
                            onPress={openCompanyView}
                          >
                            {({ isPending }) => (
                              <>
                                {isPending ? (
                                  <Spinner color="current" size="sm" />
                                ) : (
                                  <ArrowRightLeft size={14} aria-hidden />
                                )}
                                {t("detail.openCompanyView")}
                              </>
                            )}
                          </Button>
                        ) : null}
                        {data.canSeeUsage ? <InsightLinks usage={usageHref(usageFilterOf(tenancy, platform))} /> : null}
                        {canEditNode ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onPress={() => openNode(tenancy.kind, node.id, orgId, teamId)}
                          >
                            <Pencil size={14} aria-hidden />
                            {t("detail.edit", { kind: tenancy.kind })}
                          </Button>
                        ) : null}
                        {canEditNode ? (
                          <ConfirmDialog
                            title={t("detail.deleteTitle", { kind: tenancy.kind, alias: node.alias })}
                            description={t("detail.deleteHint", { kind: tenancy.kind })}
                            confirmLabel={tCommon("delete")}
                            cancelLabel={tCommon("cancel")}
                            pending={deleting}
                            onConfirm={() => remove(tenancy)}
                          >
                            <Button
                              isIconOnly
                              size="sm"
                              variant="danger-soft"
                              aria-label={t("detail.delete", { kind: tenancy.kind })}
                              isPending={deleting}
                            >
                              <Trash2 size={14} aria-hidden />
                            </Button>
                          </ConfirmDialog>
                        ) : null}
                      </>
                    ) : undefined
                  }
                />

                <BudgetCard
                  key={nodeKey(tenancy)}
                  chain={chainOf(data, tenancy.kind, node.id)}
                  budget={node.budget}
                  thresholds={data.thresholds}
                  canBudget={canBudgetNode}
                  canSeeSettings={data.canSeeSettings}
                  onEdit={() =>
                    openBudget({ kind: tenancy.kind, id: node.id, alias: node.alias }, budgetState)
                  }
                  onBoost={() =>
                    openBudget({ kind: tenancy.kind, id: node.id, alias: node.alias }, boostState)
                  }
                />

                {team ? (
                  <Card>
                    <Card.Header>
                      <Card.Title>{t("limits.title")}</Card.Title>
                      <Card.Description>{t("limits.hint")}</Card.Description>
                    </Card.Header>
                    <Card.Content>
                      <dl className="grid grid-cols-2 gap-4">
                        <div>
                          <dt className="text-xs text-muted">{t("limits.rpm")}</dt>
                          <dd className="text-lg font-semibold tabular-nums">
                            {team.rpmLimit > 0
                              ? format.number(team.rpmLimit, "integer")
                              : t("limits.unlimited")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">{t("limits.tpm")}</dt>
                          <dd className="text-lg font-semibold tabular-nums">
                            {team.tpmLimit > 0
                              ? format.number(team.tpmLimit, "integer")
                              : t("limits.unlimited")}
                          </dd>
                        </div>
                      </dl>
                    </Card.Content>
                  </Card>
                ) : null}

                {org ? (
                  <ChildrenCard
                    kind="team"
                    rows={data.teams
                      .filter((row) => row.orgId === org.id)
                      .map((row) => ({
                        id: row.id,
                        alias: row.alias,
                        budget: row.budget,
                        detail: t("children.teamDetail", {
                          members: membersIn({ teamId: row.id }).length,
                          projects: projectsIn({ teamId: row.id }).length,
                        }),
                      }))}
                    canManage={data.canManage}
                    onOpen={selectInPane}
                    onAdd={() => openNode("team", null, org.id)}
                  />
                ) : null}

                {org || team ? (
                  <ChildrenCard
                    kind="project"
                    rows={projectsIn(org ? { orgId: org.id } : { teamId }).map((row) => ({
                      id: row.id,
                      alias: row.alias,
                      budget: row.budget,
                      detail: data.canSeeKeys
                        ? t("children.projectDetail", {
                            hasTeam: org && row.teamId ? "yes" : "no",
                            team: teamAlias(row.teamId),
                            keys: keysOf("project", row.id).length,
                          })
                        : org
                          ? teamAlias(row.teamId)
                          : "",
                    }))}
                    canManage={data.canManage}
                    onOpen={selectInPane}
                    onAdd={() => openNode("project", null, orgId, team?.id ?? "")}
                  />
                ) : null}

                {org || team ? (
                  <MembersCard
                    data={data}
                    kind={org ? "org" : "team"}
                    members={membersIn(org ? { orgId: org.id } : { teamId })}
                    onOpen={selectInPane}
                    onAdd={() => openNode("member", null, orgId, team?.id ?? "")}
                    onBudget={(target) => openBudget(target, budgetState)}
                  />
                ) : null}

                {data.canSeeKeys ? (
                  <KeysCard
                    key={`keys-${nodeKey(tenancy)}`}
                    data={data}
                    kind={tenancy.kind}
                    keys={keysOf(tenancy.kind, node.id)}
                    preset={keyPresetOf(tenancy)}
                    actions={KEY_ACTIONS}
                    loadKey={loadKeyDetailAction}
                    loadChoices={loadChoices}
                    onOpen={selectInPane}
                    onBudget={openKeyBudget}
                    onChanged={applyKey}
                    onRevoked={dropKey}
                  />
                ) : null}

                {org && (accessUsers || data.canSeePolicies) ? (
                  <AccessCard
                    key={`access-${org.id}`}
                    orgId={org.id}
                    users={accessUsers}
                    loadPolicies={data.canSeePolicies ? loadCompanyPoliciesAction : null}
                    canOpen={(ref) => nodeExists(data, ref)}
                    onOpen={selectInPane}
                  />
                ) : null}

                {org ? (
                  <LabelKeysCard
                    key={`labels-${org.id}`}
                    orgId={org.id}
                    keys={org.labelKeys}
                    inherited={data.platformLabelKeys}
                    canManage={data.canManage}
                    onSaved={setData}
                  />
                ) : null}

                {org && data.canSeeMcp ? (
                  <McpConnectionsCard
                    key={`mcp-${org.id}`}
                    orgId={org.id}
                    load={loadCompanyMcpAction}
                    onInstall={saveCompanyMcpInstallationAction}
                  />
                ) : null}

                {(org || team) && data.canSeeReports ? (
                  <ReportsCard
                    key={`reports-${nodeKey(tenancy)}`}
                    kind={org ? "org" : "team"}
                    name={node.alias}
                    orgId={orgId}
                    teamId={team?.id ?? ""}
                    reports={data.reports.filter(
                      (row) => row.orgId === orgId && row.teamId === (team?.id ?? ""),
                    )}
                    people={membersIn(org ? { orgId: org.id } : { teamId })}
                    canReport={data.canReport}
                    mailEnabled={data.mailEnabled}
                    onChange={(reports) => setData((current) => ({ ...current, reports }))}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}

      <NodeDialog
        key={`node-${dialogKey}`}
        state={nodeState}
        kind={nodeForm.kind}
        editingId={nodeForm.editingId}
        orgId={nodeForm.orgId}
        teamId={nodeForm.teamId}
        data={data}
        onSaved={(payload, ref) => {
          setData(payload);
          if (nodeForm.kind === "org") consoleScope.refresh();
          if (ref) select(ref);
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
    </div>
  );
}
