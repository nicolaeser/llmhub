"use client";

import { Button, Card, Chip } from "@heroui/react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SetupStep, StructurePayload } from "@/types/structure";

const STEPS: SetupStep[] = ["org", "team", "project", "member", "budget"];

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
  onStep,
}: {
  data: StructurePayload;
  company: string | null;
  onStep: (step: SetupStep) => void;
}) {
  const t = useTranslations("Companies.steps");
  const done = setupDone(data);
  const steps = company ? STEPS.filter((step) => step !== "org") : STEPS;
  const current = steps.find((step) => !done[step]);
  const title = t("title", { scope: company ? "company" : "platform", alias: company ?? "" });

  return (
    <Card render={(props) => <section {...props} />} aria-label={title}>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        <Card.Description>{t("subtitle")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <ol className={`grid gap-3 sm:grid-cols-2 ${company ? "xl:grid-cols-4" : "xl:grid-cols-5"}`}>
          {steps.map((step, index) => {
            const isDone = done[step];
            const isCurrent = step === current;
            return (
              <li key={step} aria-current={isCurrent ? "step" : undefined}>
                <Card variant="secondary" className="h-full gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs tabular-nums text-muted">
                      {t("number", { n: index + 1 })}
                    </span>
                    <Chip size="sm" variant="soft" color={isDone ? "success" : "default"}>
                      {isDone ? <Check size={12} aria-hidden /> : null}
                      {t("status", { status: isDone ? "done" : "todo" })}
                    </Chip>
                  </div>
                  <p className="text-sm font-medium">{t(`${step}.title`)}</p>
                  <p className="text-xs text-muted">{t(`${step}.hint`)}</p>
                  {isCurrent ? (
                    <Button size="sm" className="mt-auto self-start" onPress={() => onStep(step)}>
                      {t(`${step}.action`)}
                    </Button>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ol>
      </Card.Content>
    </Card>
  );
}
