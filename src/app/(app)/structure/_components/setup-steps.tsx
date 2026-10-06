"use client";

import { Button, Card, Chip } from "@heroui/react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SetupStep, StructurePayload } from "@/types/structure";

const STEPS: SetupStep[] = ["org", "team", "project", "members", "budget"];

export function setupDone(data: StructurePayload): Record<SetupStep, boolean> {
  const capped = [...data.orgs, ...data.teams, ...data.projects, ...data.users].some(
    (row) => row.budget.maxBudget > 0,
  );
  return {
    org: data.orgs.length > 0,
    team: data.teams.some((row) => row.orgId),
    project: data.projects.some((row) => row.teamId),
    members: data.users.some((row) => row.teamId),
    budget: capped,
  };
}

export default function SetupSteps({
  data,
  onStep,
}: {
  data: StructurePayload;
  onStep: (step: SetupStep) => void;
}) {
  const t = useTranslations("Structure.steps");
  const done = setupDone(data);
  const current = STEPS.find((step) => !done[step]);

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("title")}>
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("subtitle")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {STEPS.map((step, index) => {
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
