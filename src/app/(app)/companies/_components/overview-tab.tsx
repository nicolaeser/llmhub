"use client";

import { Button, Card } from "@heroui/react";
import { ArrowRight, Folder, KeyRound, UserRound, Users } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import StatCard from "@/components/console/stat-card";
import { budgetRatio } from "@/lib/tenancy/company-view";
import type { CompanyTab, SetupStep, StructurePayload } from "@/types/structure";
import BudgetCard from "./budget-card";
import SetupSteps, { setupDone } from "./setup-steps";
import SpendMeter from "./spend-meter";
import { chainOf } from "./tree-model";

const SHOWN_TEAMS = 6;

export default function OverviewTab({
  data,
  steps,
  canBudget,
  onStep,
  onBudget,
  onBoost,
  onTab,
}: {
  data: StructurePayload;
  steps: SetupStep[];
  canBudget: boolean;
  onStep: (step: SetupStep) => void;
  onBudget: () => void;
  onBoost: () => void;
  onTab: (tab: CompanyTab) => void;
}) {
  const t = useTranslations("Companies.overview");
  const format = useFormatter();
  const org = data.orgs[0];
  if (!org) return null;
  const done = setupDone(data);
  const showSteps = data.canManage && steps.some((step) => !done[step]);
  const looseProjects = data.projects.filter((row) => !data.teams.some((team) => team.id === row.teamId)).length;
  const teams = [...data.teams]
    .sort((a, b) => (budgetRatio(b.budget) ?? -1) - (budgetRatio(a.budget) ?? -1) || a.alias.localeCompare(b.alias))
    .slice(0, SHOWN_TEAMS);
  const count = (value: number) => format.number(value, "integer");
  const hidden = data.teams.length - teams.length;
  const extra = [
    ...(hidden > 0 ? [t("more", { count: hidden })] : []),
    ...(teams.length > 0 && looseProjects > 0 ? [t("loose", { count: looseProjects })] : []),
  ];

  return (
    <div className="space-y-5">
      {showSteps ? <SetupSteps data={data} company={org.alias} steps={steps} onStep={onStep} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label={t("teams")} value={count(data.teams.length)} />
        <StatCard icon={Folder} label={t("projects")} value={count(data.projects.length)} />
        <StatCard icon={UserRound} label={t("members")} value={count(data.members.length)} />
        {data.canSeeKeys ? (
          <StatCard icon={KeyRound} label={t("keys")} value={count(data.keys.length)} />
        ) : (
          <StatCard icon={KeyRound} tone="neutral" label={t("users")} value={count(data.users.length)} />
        )}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <BudgetCard
          chain={chainOf(data, "org", org.id)}
          budget={org.budget}
          thresholds={data.thresholds}
          canBudget={canBudget}
          canSeeSettings={data.canSeeSettings}
          onEdit={onBudget}
          onBoost={onBoost}
        />
        <Card>
          <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-48">
              <Card.Title>{t("structureTitle")}</Card.Title>
              <Card.Description>{t("structureHint")}</Card.Description>
            </div>
            <Button size="sm" variant="secondary" onPress={() => onTab("structure")}>
              {t("openStructure")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          </Card.Header>
          <Card.Content>
            {teams.length === 0 ? (
              <p className="text-sm text-muted">{t("noTeams", { projects: data.projects.length })}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {teams.map((team) => (
                  <li key={team.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="text-sm font-medium break-words text-foreground">{team.alias}</p>
                      <p className="text-xs text-muted">
                        {t("teamCounts", {
                          projects: data.projects.filter((row) => row.teamId === team.id).length,
                          members: data.members.filter((row) => row.teamId === team.id).length,
                        })}
                      </p>
                    </div>
                    <div className="w-full sm:w-52">
                      <SpendMeter budget={team.budget} label={t("usage", { alias: team.alias })} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {extra.length ? <p className="mt-3 text-xs text-muted">{format.list(extra, { type: "unit" })}</p> : null}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
