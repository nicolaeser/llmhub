"use client";

import { useState } from "react";
import { Card } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { applyMarkup, pickMarkup } from "@/lib/gateway/markup-policy";
import type { PickerItem } from "@/types/console";
import type {
  MarkupOrgOption,
  MarkupProjectOption,
  MarkupRule,
  MarkupTeamOption,
  MarkupView,
} from "@/types/pricing";

const NONE = "none";

const EXAMPLE_PURCHASE = 100;

export default function MarkupLookup({
  markups,
  orgs,
  teams,
  projects,
  models,
  describe,
}: {
  markups: MarkupView[];
  orgs: MarkupOrgOption[];
  teams: MarkupTeamOption[];
  projects: MarkupProjectOption[];
  models: string[];
  describe: (rule: MarkupRule) => string;
}) {
  const t = useTranslations("Markups");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [orgId, setOrgId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState(models[0] ?? "");

  const none: PickerItem = { id: NONE, label: tCommon("none") };
  const teamItems = teams
    .filter((team) => team.orgId === orgId)
    .map((team) => ({ id: team.id, label: team.alias }));
  const projectItems = projects
    .filter((project) => project.orgId === orgId && (!teamId || project.teamId === teamId))
    .map((project) => ({ id: project.id, label: project.alias }));
  const match = pickMarkup(markups, { orgId, teamId, projectId, model });
  const percent = match?.percent ?? 0;

  function pickOrg(id: string) {
    setOrgId(id === NONE ? "" : id);
    setTeamId("");
    setProjectId("");
  }

  function pickTeam(id: string) {
    setTeamId(id === NONE ? "" : id);
    setProjectId("");
  }

  function pickProject(id: string) {
    const project = projects.find((row) => row.id === id);
    setProjectId(project?.id ?? "");
    if (project) setTeamId(project.teamId);
  }

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("lookup.title")}</Card.Title>
        <Card.Description>{t("lookup.description")}</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SearchSelect
            label={t("scope", { scope: "org" })}
            items={[none, ...orgs.map((org) => ({ id: org.id, label: org.alias }))]}
            value={orgId || NONE}
            onChange={pickOrg}
          />
          <SearchSelect
            label={t("scope", { scope: "team" })}
            items={[none, ...teamItems]}
            value={teamId || NONE}
            onChange={pickTeam}
            isDisabled={!orgId}
          />
          <SearchSelect
            label={t("scope", { scope: "project" })}
            items={[none, ...projectItems]}
            value={projectId || NONE}
            onChange={pickProject}
            isDisabled={!orgId}
          />
          <SearchSelect
            label={t("lookup.model")}
            items={models.map((alias) => ({ id: alias, label: alias }))}
            value={model}
            onChange={setModel}
          />
        </div>
        <output aria-live="polite" className="block rounded-lg bg-default px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span
              className={
                percent > 0
                  ? "text-2xl font-semibold text-success tabular-nums"
                  : percent < 0
                    ? "text-2xl font-semibold text-warning tabular-nums"
                    : "text-2xl font-semibold text-muted tabular-nums"
              }
            >
              {format.number(percent / 100, "markup")}
            </span>
            <span className="text-sm text-muted tabular-nums">
              {t("lookup.example", {
                purchase: EXAMPLE_PURCHASE,
                sale: applyMarkup(EXAMPLE_PURCHASE, percent),
              })}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {match ? t("lookup.matched", { rule: describe(match) }) : t("lookup.unmatched")}
          </p>
        </output>
      </Card.Content>
    </Card>
  );
}
