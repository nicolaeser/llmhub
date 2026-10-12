"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Breadcrumbs, Button, Card, Spinner, toast, useOverlayState } from "@heroui/react";
import { Building2, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type {
  BudgetResult,
  BudgetTarget,
  NodeKind,
  NodeRef,
  SetupStep,
  StructurePayload,
} from "@/types/structure";
import { deleteNodeAction, loadStructureAction, setBudgetAction } from "./_action";
import AlertsCard from "./_components/alerts-card";
import BoostDialog from "./_components/boost-dialog";
import BudgetCard from "./_components/budget-card";
import ChildrenCard from "./_components/children-card";
import CompanyTree from "./_components/company-tree";
import KeysCard from "./_components/keys-card";
import MembersCard from "./_components/members-card";
import NodeDialog from "./_components/node-dialog";
import ReportsCard from "./_components/reports-card";
import SetupSteps, { setupDone } from "./_components/setup-steps";
import { budgetOf, chainOf, nodeExists, parseNodeRef, withBudget } from "./_components/tree-model";

function firstNode(data: StructurePayload): NodeRef | null {
  return data.orgs[0] ? { kind: "org", id: data.orgs[0].id } : null;
}

export default function CompaniesPage() {
  const t = useTranslations("Companies");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const nodeParam = useSearchParam("node");
  const [data, setData] = useState<StructurePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<NodeRef | null>(null);
  const [nodeForm, setNodeForm] = useState<{
    kind: NodeKind;
    editingId: string | null;
    orgId: string;
    teamId: string;
  }>({ kind: "org", editingId: null, orgId: "", teamId: "" });
  const [budgetTarget, setBudgetTarget] = useState<BudgetTarget | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, startDelete] = useTransition();
  const nodeState = useOverlayState();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();

  useEffect(() => {
    loadStructureAction().then((result) => {
      if (isActionFail(result)) {
        setLoadError(result.error);
        return;
      }
      setData(result);
    });
  }, []);

  function select(ref: NodeRef | null) {
    setPicked(ref);
    window.history.replaceState(
      null,
      "",
      ref ? `?node=${ref.kind}:${ref.id}` : window.location.pathname,
    );
  }

  function openNode(kind: NodeKind, editingId: string | null, orgId: string, teamId = "") {
    setNodeForm({ kind, editingId, orgId, teamId });
    setDialogKey((n) => n + 1);
    nodeState.open();
  }

  function openBudget(target: BudgetTarget, state: ReturnType<typeof useOverlayState>) {
    setBudgetTarget(target);
    setDialogKey((n) => n + 1);
    state.open();
  }

  function applyBudget(result: BudgetResult) {
    setData((current) =>
      current ? withBudget(current, result.kind, result.id, result.budget) : current,
    );
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{tError("code", { code: loadError })}</Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
  }

  if (!data) {
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

  const platform = !data.companyId;
  const selected =
    [picked, parseNodeRef(nodeParam)].find((ref) => nodeExists(data, ref)) ?? firstNode(data);
  const org = selected?.kind === "org" ? data.orgs.find((row) => row.id === selected.id) : undefined;
  const team = selected?.kind === "team" ? data.teams.find((row) => row.id === selected.id) : undefined;
  const project =
    selected?.kind === "project" ? data.projects.find((row) => row.id === selected.id) : undefined;
  const member =
    selected?.kind === "member" ? data.members.find((row) => row.id === selected.id) : undefined;
  const placed = team ?? project ?? member;
  const node = org ?? placed;
  const orgId = org?.id ?? placed?.orgId ?? "";
  const teamId = team?.id ?? project?.teamId ?? member?.teamId ?? "";
  const parentOrg = data.orgs.find((row) => row.id === orgId);
  const parentTeam = !team ? data.teams.find((row) => row.id === teamId) : undefined;
  const crumbs = [
    ...(parentOrg && !org ? [{ ref: `org:${parentOrg.id}`, alias: parentOrg.alias }] : []),
    ...(parentTeam ? [{ ref: `team:${parentTeam.id}`, alias: parentTeam.alias }] : []),
    ...(node && selected ? [{ ref: `${selected.kind}:${node.id}`, alias: node.alias }] : []),
  ];
  const projectsIn = (where: { orgId?: string; teamId?: string }) =>
    data.projects.filter(
      (row) => (!where.orgId || row.orgId === where.orgId) && (!where.teamId || row.teamId === where.teamId),
    );
  const membersIn = (where: { orgId?: string; teamId?: string }) =>
    data.members.filter(
      (row) => (!where.orgId || row.orgId === where.orgId) && (!where.teamId || row.teamId === where.teamId),
    );
  const keysOf = (kind: NodeKind, id: string) =>
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
  const showSteps = data.canManage && Object.values(done).some((value) => !value);
  const budgetFor = budgetTarget ? budgetOf(data, budgetTarget.kind, budgetTarget.id) : null;
  const canEditNode = data.canManage && (selected?.kind !== "org" || platform);
  const canBudgetNode = data.canBudget && (selected?.kind !== "org" || platform);

  function onStep(step: SetupStep) {
    const target = orgId || data?.orgs[0]?.id || "";
    if (step === "org") openNode("org", null, "");
    if (step === "team") openNode("team", null, target);
    if (step === "project") openNode("project", null, target, team?.id ?? "");
    if (step === "member") openNode("member", null, target, team?.id ?? "");
    if (step === "budget" && data?.orgs[0]) {
      const kind = platform ? "org" : data.teams[0] ? "team" : null;
      const row = kind === "org" ? data.orgs[0] : data.teams[0];
      if (kind && row) openBudget({ kind, id: row.id, alias: row.alias }, budgetState);
    }
  }

  function remove(ref: NodeRef) {
    startDelete(async () => {
      const result = await deleteNodeAction(ref);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setData(result);
      const parent: NodeRef | null =
        ref.kind === "org"
          ? null
          : ref.kind !== "team" && parentTeam
            ? { kind: "team", id: parentTeam.id }
            : parentOrg
              ? { kind: "org", id: parentOrg.id }
              : null;
      select(parent);
      toast(t("detail.deleted", { kind: ref.kind }), { variant: "success" });
    });
  }

  const createOrg = data.canManage && platform ? () => openNode("org", null, "") : null;
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
        title={t("title")}
        subtitle={t("subtitle", { scope: platform ? "platform" : "company" })}
        actions={
          createOrg && node ? (
            <Button onPress={createOrg}>
              <Plus size={16} aria-hidden />
              {t("createOrg")}
            </Button>
          ) : undefined
        }
      />

      {showSteps ? <SetupSteps data={data} onStep={onStep} /> : null}

      {!node || !selected ? (
        <EmptyState
          icon={Building2}
          title={t("emptyTitle")}
          description={t("empty", { scope: platform ? "platform" : "company" })}
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
            <CompanyTree data={data} selected={selected} onSelect={select} onCreateOrg={createOrg} />
          </div>

          <div className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                {crumbs.length > 1 ? (
                  <Breadcrumbs
                    onAction={(key) => {
                      const ref = parseNodeRef(String(key));
                      if (ref) select(ref);
                    }}
                  >
                    {crumbs.map((crumb) => (
                      <Breadcrumbs.Item key={crumb.ref} id={crumb.ref}>
                        {crumb.alias}
                      </Breadcrumbs.Item>
                    ))}
                  </Breadcrumbs>
                ) : null}
                <h2 className="text-lg font-semibold tracking-tight break-words">{node.alias}</h2>
                <p className="text-sm text-muted">
                  {t("detail.kind", { kind: selected.kind })}
                  {" · "}
                  {summary}
                </p>
              </div>
              {canEditNode ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => openNode(selected.kind, node.id, orgId, teamId)}
                  >
                    <Pencil size={14} aria-hidden />
                    {t("detail.edit", { kind: selected.kind })}
                  </Button>
                  <ConfirmDialog
                    title={t("detail.deleteTitle", { kind: selected.kind, alias: node.alias })}
                    description={t("detail.deleteHint", { kind: selected.kind })}
                    confirmLabel={tCommon("delete")}
                    cancelLabel={tCommon("cancel")}
                    pending={deleting}
                    onConfirm={() => remove(selected)}
                  >
                    <Button
                      isIconOnly
                      size="sm"
                      variant="danger-soft"
                      aria-label={t("detail.delete", { kind: selected.kind })}
                      isPending={deleting}
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </ConfirmDialog>
                </div>
              ) : null}
            </div>

            <BudgetCard
              key={`${selected.kind}:${node.id}`}
              chain={chainOf(data, selected.kind, node.id)}
              budget={node.budget}
              canBudget={canBudgetNode}
              onEdit={() =>
                openBudget({ kind: selected.kind, id: node.id, alias: node.alias }, budgetState)
              }
              onBoost={() =>
                openBudget({ kind: selected.kind, id: node.id, alias: node.alias }, boostState)
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
                onOpen={select}
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
                  detail: t("children.projectDetail", {
                    hasTeam: org && row.teamId ? "yes" : "no",
                    team: teamAlias(row.teamId),
                    keys: keysOf("project", row.id).length,
                  }),
                }))}
                canManage={data.canManage}
                onOpen={select}
                onAdd={() => openNode("project", null, orgId, team?.id ?? "")}
              />
            ) : null}

            {org || team ? (
              <MembersCard
                data={data}
                kind={org ? "org" : "team"}
                members={membersIn(org ? { orgId: org.id } : { teamId })}
                onOpen={select}
                onAdd={() => openNode("member", null, orgId, team?.id ?? "")}
                onBudget={(target) => openBudget(target, budgetState)}
              />
            ) : null}

            <KeysCard
              data={data}
              kind={selected.kind}
              keys={keysOf(selected.kind, node.id)}
              createFor={
                project
                  ? { kind: "project", id: project.id }
                  : member
                    ? { kind: "member", id: member.id }
                    : null
              }
              onBudget={(target) => openBudget(target, budgetState)}
            />

            {(org || team) && data.canSeeReports ? (
              <ReportsCard
                key={`reports-${selected.kind}:${node.id}`}
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
                onChange={(reports) =>
                  setData((current) => (current ? { ...current, reports } : current))
                }
              />
            ) : null}
          </div>
        </div>
      )}

      {data.canBudget && platform ? (
        <AlertsCard
          thresholds={data.thresholds}
          onSaved={(thresholds) =>
            setData((current) => (current ? { ...current, thresholds } : current))
          }
        />
      ) : null}

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
        onSaved={applyBudget}
      />
    </div>
  );
}
