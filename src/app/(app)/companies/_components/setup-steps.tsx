"use client";

import { Button, Card, Chip } from "@heroui/react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SetupStep, StructurePayload } from "@/types/structure";

export function setupDone(data: StructurePayload): Record<SetupStep, boolean> {
  const capped = [...data.orgs, ...data.teams, ...data.projects, ...data.members].some(
    (row) => row.budget.maxBudget > 0,
  );
  return {
    org: data.orgs.length > 0,
    team: data.teams.length > 0,
    project: data.projects.length > 0,
    member: data.members.length > 0,
    budget: capped,
  };
}

export default function SetupSteps({
  data,
  company,
  steps,
  onStep,
}: {
  data: StructurePayload;
  company: string;
  steps: SetupStep[];
  onStep: (step: SetupStep) => void;
}) {
  const t = useTranslations("Companies.steps");
  const done = setupDone(data);
  const current = steps.find((step) => !done[step]);
  const finished = steps.filter((step) => done[step]).length;
  const title = t("title", { alias: company });

  return (
    <Card render={(props) => <section {...props} />} aria-label={title}>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <Card.Title>{title}</Card.Title>
          <Card.Description>{t("subtitle")}</Card.Description>
        </div>
        <Chip size="sm" variant="soft">
          {t("progress", { done: finished, total: steps.length })}
        </Chip>
      </Card.Header>
      <Card.Content>
        <ol className="flex flex-col divide-y divide-border">
          {steps.map((step, index) => {
            const isDone = done[step];
            const isCurrent = step === current;
            return (
              <li
                key={step}
                aria-current={isCurrent ? "step" : undefined}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                    isDone ? "bg-success/12 text-success" : isCurrent ? "bg-accent/12 text-accent" : "bg-default text-muted"
                  }`}
                  aria-hidden
                >
                  {isDone ? <Check size={14} /> : index + 1}
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className={`text-sm font-medium ${isDone ? "text-muted" : "text-foreground"}`}>
                    {t(`${step}.title`)}
                    <span className="sr-only"> {t("status", { status: isDone ? "done" : "todo" })}</span>
                  </p>
                  <p className="text-xs text-muted">{t(`${step}.hint`)}</p>
                </div>
                {isCurrent ? (
                  <Button size="sm" onPress={() => onStep(step)}>
                    {t(`${step}.action`)}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card.Content>
    </Card>
  );
}
