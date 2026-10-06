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
import KeysCard from "./_components/keys-card";
import MembersCard from "./_components/members-card";
import NodeDialog from "./_components/node-dialog";
import SetupSteps, { setupDone } from "./_components/setup-steps";
import StructureTree from "./_components/structure-tree";
import { budgetOf, chainOf, nodeExists, parseNodeRef, withBudget } from "./_components/tree-model";

function firstNode(data: StructurePayload): NodeRef | null {
  if (data.orgs[0]) return { kind: "org", id: data.orgs[0].id };
  if (data.teams[0]) return { kind: "team", id: data.teams[0].id };
  if (data.projects[0]) return { kind: "project", id: data.projects[0].id };
  return null;
}

export default function StructurePage() {
  const t = useTranslations("Structure");
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
    parentId: string;
  }>({ kind: "org", editingId: null, parentId: "" });
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

  function select(ref: NodeRef) {
    setPicked(ref);
    window.history.replaceState(null, "", `?node=${ref.kind}:${ref.id}`);
  }

  function openNode(kind: NodeKind, editingId: string | null, parentId: string) {
    setNodeForm({ kind, editingId, parentId });
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

  const selected =
    [picked, parseNodeRef(nodeParam)].find((ref) => nodeExists(data, ref)) ?? firstNode(data);
  const org = selected?.kind === "org" ? data.orgs.find((row) => row.id === selected.id) : undefined;
  const team =
    selected?.kind === "team" ? data.teams.find((row) => row.id === selected.id) : undefined;
  const project =
    selected?.kind === "project"
      ? data.projects.find((row) => row.id === selected.id)
      : undefined;
  const parentTeam = project ? data.teams.find((row) => row.id === project.teamId) : undefined;
  const parentOrg = data.orgs.find((row) => row.id === (team?.orgId ?? parentTeam?.orgId));
  const node = org ?? team ?? project;
  const crumbs = [
    ...(parentOrg && !org ? [{ ref: `org:${parentOrg.id}`, alias: parentOrg.alias }] : []),
    ...(parentTeam ? [{ ref: `team:${parentTeam.id}`, alias: parentTeam.alias }] : []),
    ...(node && selected ? [{ ref: `${selected.kind}:${node.id}`, alias: node.alias }] : []),
  ];
  const membersOf = (teamId: string) => data.users.filter((user) => user.teamId === teamId);
  const keysOf = (kind: "team" | "project", id: string) =>
    data.keys.filter((key) => (kind === "team" ? key.teamId : key.projectId) === id);
  const firstTeam = data.teams.find((row) => row.orgId) ?? data.teams[0];
  const done = setupDone(data);
  const showSteps = data.canManage && Object.values(done).some((value) => !value);
  const budgetFor = budgetTarget ? budgetOf(data, budgetTarget.kind, budgetTarget.id) : null;

  function onStep(step: SetupStep) {
    const orgId = org?.id ?? parentOrg?.id ?? data?.orgs[0]?.id ?? "";
    if (step === "org") openNode("org", null, "");
    if (step === "team") openNode("team", null, orgId);
    if (step === "project") openNode("project", null, team?.id ?? firstTeam?.id ?? "");
    if (step === "members" && firstTeam) select({ kind: "team", id: firstTeam.id });
    if (step === "budget" && data?.orgs[0]) {
      openBudget({ kind: "org", id: data.orgs[0].id, alias: data.orgs[0].alias }, budgetState);
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
      const parent =
        ref.kind === "project" && parentTeam
          ? { kind: "team" as const, id: parentTeam.id }
          : ref.kind === "team" && parentOrg
            ? { kind: "org" as const, id: parentOrg.id }
            : null;
      setPicked(parent);
      window.history.replaceState(
        null,
        "",
        parent ? `?node=${parent.kind}:${parent.id}` : window.location.pathname,
      );
      toast(t("detail.deleted", { kind: ref.kind }), { variant: "success" });
    });
  }

  const createOrg = data.canManage ? () => openNode("org", null, "") : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
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
          description={t("empty")}
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
            <StructureTree
              data={data}
              selected={selected}
              onSelect={select}
              onCreateOrg={createOrg}
            />
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
                  {org
                    ? t("detail.orgSummary", {
                        teams: data.teams.filter((row) => row.orgId === org.id).length,
                        members: data.users.filter((user) => user.orgId === org.id).length,
                      })
                    : team
                      ? t("detail.teamSummary", {
                          projects: data.projects.filter((row) => row.teamId === team.id).length,
                          members: membersOf(team.id).length,
                        })
                      : t("detail.projectSummary", {
                          keys: project ? keysOf("project", project.id).length : 0,
                        })}
                </p>
              </div>
              {data.canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      openNode(selected.kind, node.id, team?.orgId ?? project?.teamId ?? "")
                    }
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
              canBudget={data.canBudget}
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
                      members: membersOf(row.id).length,
                      projects: data.projects.filter((item) => item.teamId === row.id).length,
                    }),
                  }))}
                canManage={data.canManage}
                onOpen={select}
                onAdd={() => openNode("team", null, org.id)}
              />
            ) : null}

            {team ? (
              <ChildrenCard
                kind="project"
                rows={data.projects
                  .filter((row) => row.teamId === team.id)
                  .map((row) => ({
                    id: row.id,
                    alias: row.alias,
                    budget: row.budget,
                    detail: t("children.projectDetail", {
                      keys: keysOf("project", row.id).length,
                    }),
                  }))}
                canManage={data.canManage}
                onOpen={select}
                onAdd={() => openNode("project", null, team.id)}
              />
            ) : null}

            {org || team ? (
              <MembersCard
                key={`members-${selected.kind}:${node.id}`}
                data={data}
                kind={org ? "org" : "team"}
                id={node.id}
                onChanged={setData}
                onBudget={(target) => openBudget(target, budgetState)}
              />
            ) : null}

            {team || project ? (
              <KeysCard
                data={data}
                kind={team ? "team" : "project"}
                keys={keysOf(team ? "team" : "project", node.id)}
                onBudget={(target) => openBudget(target, budgetState)}
              />
            ) : null}
          </div>
        </div>
      )}

      {data.canBudget ? (
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
        parentId={nodeForm.parentId}
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
