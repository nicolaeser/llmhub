"use client";

import { useEffect, useState } from "react";
import { Button, Card, SearchField } from "@heroui/react";
import { Folder, FolderPlus, Network, Plus, Users } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import IconTile from "@/components/console/icon-tile";
import type { DepartmentGroup, NodeRef, ProjectNode, StructurePayload, TeamNode } from "@/types/structure";
import NodeMenu from "./node-menu";
import SpendMeter from "./spend-meter";
import { nodeActions, nodeKey, structureGroups, type NodeAction, type NodeFlags } from "./tree-model";

const SEARCH_FROM = 6;

export default function StructureTab({
  data,
  flags,
  focus,
  onAdd,
  onAction,
}: {
  data: StructurePayload;
  flags: NodeFlags;
  focus: NodeRef | null;
  onAdd: (kind: "team" | "project", teamId?: string) => void;
  onAction: (ref: { kind: "team" | "project"; id: string; alias: string }, action: NodeAction) => void;
}) {
  const t = useTranslations("Companies.structure");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const groups = structureGroups(data, query);
  const total = data.teams.length + data.projects.length;
  const focused = focus ? nodeKey(focus) : null;
  const keyCount = (projectId: string) => data.keys.filter((key) => key.projectId === projectId).length;

  useEffect(() => {
    if (focused) document.getElementById(`node-${focused}`)?.scrollIntoView({ block: "center" });
  }, [focused]);

  const addButtons = flags.canManage ? (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onPress={() => onAdd("team")}>
        <Users size={16} aria-hidden />
        {t("addTeam")}
      </Button>
      <Button onPress={() => onAdd("project")}>
        <Plus size={16} aria-hidden />
        {t("addProject")}
      </Button>
    </div>
  ) : null;

  if (total === 0) {
    return (
      <EmptyState
        icon={Network}
        title={t("emptyTitle")}
        description={t("empty", { manage: flags.canManage ? "yes" : "no" })}
        action={addButtons ?? undefined}
      />
    );
  }

  function highlight(kind: "team" | "project", id: string) {
    return focused === `${kind}:${id}` ? "bg-accent/8 ring-1 ring-inset ring-accent/25" : "";
  }

  function teamDetail(group: DepartmentGroup & { team: TeamNode }) {
    const limits = [
      group.team.rpmLimit > 0 ? t("rpm", { value: group.team.rpmLimit }) : "",
      group.team.tpmLimit > 0 ? t("tpm", { value: group.team.tpmLimit }) : "",
    ].filter(Boolean);
    return format.list(
      [t("projectCount", { count: group.projects.length }), t("memberCount", { count: group.members }), ...limits],
      { type: "unit" },
    );
  }

  function projectRow(project: ProjectNode) {
    const actions = nodeActions("project", flags, project.budget.maxBudget > 0);
    const detail = [
      project.owner,
      flags.canCreateKeys || data.canSeeKeys ? t("keys", { count: keyCount(project.id) }) : "",
    ].filter(Boolean);
    return (
      <li
        key={project.id}
        id={`node-project:${project.id}`}
        className={`flex items-start gap-3 rounded-xl px-2 py-2.5 ${highlight("project", project.id)}`}
      >
        <Folder size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-sm font-medium break-words text-foreground">{project.alias}</p>
            {detail.length ? (
              <p className="text-xs break-words text-muted">{format.list(detail, { type: "unit" })}</p>
            ) : null}
          </div>
          <div className="w-full sm:w-56">
            <SpendMeter budget={project.budget} label={t("usage", { alias: project.alias })} />
          </div>
        </div>
        <NodeMenu
          kind="project"
          name={project.alias}
          actions={actions}
          onAction={(action) => onAction({ kind: "project", id: project.id, alias: project.alias }, action)}
        />
      </li>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {total >= SEARCH_FROM ? (
          <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("search")} />
              <SearchField.ClearButton aria-label={t("clear")} />
            </SearchField.Group>
          </SearchField>
        ) : (
          <p className="max-w-2xl text-sm text-muted">{t("hint")}</p>
        )}
        {addButtons}
      </div>

      {groups.length === 0 ? (
        <Card>
          <Card.Content>
            <p className="text-sm text-muted">{t("noMatches")}</p>
          </Card.Content>
        </Card>
      ) : (
        <ul className="space-y-4" aria-label={t("title")}>
          {groups.map((group) => {
            const team = group.team;
            return (
              <li key={team?.id ?? "none"}>
                <Card className="gap-2">
                  {team ? (
                    <div
                      id={`node-team:${team.id}`}
                      className={`flex items-start gap-3 rounded-xl px-2 py-1 ${highlight("team", team.id)}`}
                    >
                      <IconTile icon={Users} size="sm" />
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
                        <div className="min-w-0 flex-1 basis-48">
                          <h3 className="text-sm font-semibold break-words text-foreground">{team.alias}</h3>
                          <p className="text-xs text-muted">{teamDetail({ ...group, team })}</p>
                        </div>
                        <div className="w-full sm:w-56">
                          <SpendMeter budget={team.budget} label={t("usage", { alias: team.alias })} />
                        </div>
                      </div>
                      <NodeMenu
                        kind="team"
                        name={team.alias}
                        actions={nodeActions("team", flags, team.budget.maxBudget > 0)}
                        onAction={(action) => onAction({ kind: "team", id: team.id, alias: team.alias }, action)}
                      />
                    </div>
                  ) : (
                    <div className="flex items-start gap-3 px-2 py-1">
                      <IconTile icon={Folder} size="sm" tone="neutral" />
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">{t("looseTitle")}</h3>
                        <p className="text-xs text-muted">{t("looseHint")}</p>
                      </div>
                    </div>
                  )}
                  {group.projects.length ? (
                    <ul className="ml-4 border-l border-border pl-3" aria-label={t("projectsOf", { name: team?.alias ?? "" })}>
                      {group.projects.map(projectRow)}
                    </ul>
                  ) : team ? (
                    <div className="ml-4 flex flex-wrap items-center gap-3 border-l border-border py-1 pl-5">
                      <p className="text-xs text-muted">{t("teamEmpty")}</p>
                      {flags.canManage ? (
                        <Button size="sm" variant="ghost" onPress={() => onAdd("project", team.id)}>
                          <FolderPlus size={14} aria-hidden />
                          {t("addHere")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
