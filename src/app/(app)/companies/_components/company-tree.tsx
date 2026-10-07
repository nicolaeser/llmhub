"use client";

import { useState } from "react";
import { Button, Card, ListBox, SearchField } from "@heroui/react";
import { Building2, Folder, Plus, Users } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { BudgetView, NodeRef, StructurePayload } from "@/types/structure";
import { parseNodeRef, usedRatio } from "./tree-model";

type TreeKind = "org" | "team" | "project";

const ICONS = { org: Building2, team: Users, project: Folder } as const;
const INDENT = ["", "pl-5", "pl-10"] as const;

function matches(alias: string, query: string) {
  return !query || alias.toLowerCase().includes(query);
}

export default function CompanyTree({
  data,
  selected,
  onSelect,
  onCreateOrg,
}: {
  data: StructurePayload;
  selected: NodeRef | null;
  onSelect: (ref: NodeRef) => void;
  onCreateOrg: (() => void) | null;
}) {
  const t = useTranslations("Companies");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const teamIds = new Set(data.teams.map((row) => row.id));
  const projectsOf = (teamId: string) =>
    data.projects.filter((row) => row.teamId === teamId && matches(row.alias, q));
  const directProjects = (orgId: string) =>
    data.projects.filter(
      (row) => row.orgId === orgId && !teamIds.has(row.teamId) && matches(row.alias, q),
    );
  const teamVisible = (team: StructurePayload["teams"][number]) =>
    matches(team.alias, q) || projectsOf(team.id).length > 0;
  const teamsOf = (orgId: string) =>
    data.teams.filter((row) => row.orgId === orgId && teamVisible(row));
  const orgs = data.orgs.filter(
    (org) => matches(org.alias, q) || teamsOf(org.id).length > 0 || directProjects(org.id).length > 0,
  );
  const selectedKey = selected && selected.kind !== "member" ? `${selected.kind}:${selected.id}` : null;

  function item(kind: TreeKind, id: string, alias: string, budget: BudgetView, depth: 0 | 1 | 2) {
    const Icon = ICONS[kind];
    const ratio = usedRatio(budget);
    const active = selectedKey === `${kind}:${id}`;
    return (
      <ListBox.Item key={`${kind}:${id}`} id={`${kind}:${id}`} textValue={alias}>
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${INDENT[depth]}`}>
          <Icon
            size={14}
            aria-hidden
            className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}
          />
          <span
            className={`min-w-0 break-words text-sm ${active ? "font-medium text-accent" : ""}`}
          >
            {alias}
          </span>
        </div>
        <span
          className={`shrink-0 text-xs tabular-nums ${ratio != null && ratio >= 1 ? "text-danger" : "text-muted"}`}
        >
          {ratio == null ? t("tree.unlimited") : format.number(ratio, "percent")}
        </span>
        <ListBox.ItemIndicator />
      </ListBox.Item>
    );
  }

  const rows = orgs.flatMap((org) => [
    item("org", org.id, org.alias, org.budget, 0),
    ...teamsOf(org.id).flatMap((team) => [
      item("team", team.id, team.alias, team.budget, 1),
      ...projectsOf(team.id).map((project) =>
        item("project", project.id, project.alias, project.budget, 2),
      ),
    ]),
    ...directProjects(org.id).map((project) =>
      item("project", project.id, project.alias, project.budget, 1),
    ),
  ]);

  return (
    <Card className="gap-3">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title>{t("tree.title")}</Card.Title>
        {onCreateOrg ? (
          <Button size="sm" variant="tertiary" onPress={onCreateOrg}>
            <Plus size={14} aria-hidden />
            {t("tree.addOrg")}
          </Button>
        ) : null}
      </Card.Header>
      <SearchField value={query} onChange={setQuery} aria-label={t("tree.search")}>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder={t("tree.search")} />
          <SearchField.ClearButton aria-label={t("tree.clear")} />
        </SearchField.Group>
      </SearchField>
      {rows.length === 0 ? (
        <p className="px-1 text-sm text-muted">{t("tree.noMatches")}</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <ListBox
            aria-label={t("tree.title")}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={selectedKey ? [selectedKey] : []}
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const ref = parseNodeRef(String([...keys][0] ?? ""));
              if (ref) onSelect(ref);
            }}
          >
            {rows}
          </ListBox>
        </div>
      )}
    </Card>
  );
}
