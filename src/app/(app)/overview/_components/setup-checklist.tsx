"use client";

import { buttonVariants, Card, Chip, Label, ProgressBar, Separator } from "@heroui/react";
import { ArrowRight, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { nextStep } from "@/lib/console/overview-view";
import type { OverviewStep } from "@/types/console";

function StepMark({ position, done, current }: { position: number; done: boolean; current: boolean }) {
  if (done) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success/12 text-success" aria-hidden>
        <Check size={14} />
      </span>
    );
  }
  return (
    <span
      className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums ${
        current ? "bg-accent text-accent-foreground" : "text-muted ring-1 ring-border ring-inset"
      }`}
      aria-hidden
    >
      {position}
    </span>
  );
}

export default function SetupChecklist({ steps }: { steps: readonly OverviewStep[] }) {
  const t = useTranslations("Overview.setup");
  const done = steps.filter((step) => step.done).length;
  const complete = done === steps.length;
  const current = nextStep(steps);

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("title")} className="gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </div>
        <Chip size="sm" variant="soft" color={complete ? "success" : "default"}>
          {complete ? t("complete") : t("progress", { done, total: steps.length })}
        </Chip>
      </Card.Header>
      <ProgressBar
        size="sm"
        value={done}
        maxValue={Math.max(1, steps.length)}
        color={complete ? "success" : "accent"}
        aria-label={t("progress", { done, total: steps.length })}
      >
        <Label className="sr-only">{t("title")}</Label>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <Card.Content>
        <ol aria-label={t("title")}>
          {steps.map((step, index) => {
            const isCurrent = current?.id === step.id;
            return (
              <li key={step.id} aria-current={isCurrent ? "step" : undefined}>
                {index > 0 ? <Separator /> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <StepMark position={index + 1} done={step.done} current={isCurrent} />
                  <div className={`min-w-0 flex-1 ${isCurrent ? "basis-56" : ""}`}>
                    <p className={`text-sm font-medium ${step.done ? "text-muted" : "text-foreground"}`}>
                      {t(`steps.${step.id}.title`)}
                      <span className="sr-only">: {t("status", { done: step.done ? "true" : "false" })}</span>
                    </p>
                    {step.done ? null : <p className="text-sm text-muted">{t(`steps.${step.id}.hint`)}</p>}
                  </div>
                  {step.href ? (
                    <Link
                      href={step.href}
                      className={buttonVariants({ size: "sm", variant: isCurrent ? "primary" : "ghost" })}
                    >
                      {isCurrent ? t(`steps.${step.id}.action`) : t("open")}
                      {isCurrent ? <ArrowRight size={14} aria-hidden /> : null}
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Card.Content>
    </Card>
  );
}
