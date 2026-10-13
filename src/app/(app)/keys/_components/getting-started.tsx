"use client";

import { Button, Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

const STEPS = [
  { id: "provider", href: "/providers" },
  { id: "model", href: "/models" },
  { id: "key", href: null },
] as const;

export default function GettingStarted({
  providers,
  models,
  keys,
  onCreateKey,
}: {
  providers: number;
  models: number;
  keys: number;
  onCreateKey: () => void;
}) {
  const t = useTranslations("Keys.gettingStarted");
  const tCommon = useTranslations("Common");
  const done = {
    provider: providers > 0,
    model: models > 0,
    key: keys > 0,
  };
  const current = STEPS.find((step) => !done[step.id])?.id;
  const labels = {
    provider: t("provider"),
    model: t("model"),
    key: t("key"),
  };

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("title")}>
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("subtitle")}</Card.Description>
      </Card.Header>
      <ol className="grid gap-3 md:grid-cols-3">
        {STEPS.map((step, index) => {
          const isDone = done[step.id];
          const isCurrent = step.id === current;
          const label = labels[step.id];
          const nameClass = isCurrent
            ? "text-sm font-semibold text-accent"
            : "text-sm font-medium text-accent";
          const name = isDone ? (
            step.href ? (
              <Link href={step.href} className="text-sm font-medium text-accent">
                {label}
              </Link>
            ) : (
              <span className="text-sm font-medium text-foreground">{label}</span>
            )
          ) : step.href ? (
            <Link href={step.href} className={nameClass}>
              {label}
            </Link>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onPress={onCreateKey}
              className={nameClass}
              aria-label={label}
            >
              {label}
            </Button>
          );
          return (
            <li
              key={step.id}
              aria-current={isCurrent ? "step" : undefined}
              className={`rounded-lg px-3 py-2 ${isCurrent ? "bg-accent/10 ring-1 ring-accent/20" : "bg-default"}`}
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-xs tabular-nums text-muted">
                  {tCommon("tenancy.step", { n: index + 1 })}
                </span>
                {name}
                <span
                  className={`text-xs font-medium ${isDone ? "text-success" : "text-muted"}`}
                >
                  {t("status", { status: isDone ? "done" : "todo" })}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
