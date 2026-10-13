"use client";

import { useState } from "react";
import { Alert, Card } from "@heroui/react";
import { Calculator } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { loadWhatIfAction } from "./_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { compareCost } from "@/lib/usage/what-if";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import SearchSelect from "@/components/console/search-select";
import StatCard from "@/components/console/stat-card";
import TargetTable from "./_components/target-table";
import type { WhatIfTarget, WhatIfView } from "@/types/what-if";

const ALL_MODELS = "all";

function defaultTarget(view: WhatIfView): WhatIfTarget | null {
  const others = view.targets.filter((target) => target.alias !== view.model);
  return others.find((target) => target.state === "active") ?? others[0] ?? null;
}

export default function WhatIfPage() {
  const t = useTranslations("WhatIf");
  const format = useFormatter();
  const [target, setTarget] = useState("");
  const whatIf = useActionData(() => loadWhatIfAction({ model: "" }));
  const { data: view, pending } = whatIf;

  function load(model: string) {
    whatIf.reloadWith(() => loadWhatIfAction({ model }));
  }

  if (!view) {
    return <PageStatus title={t("title")} state={whatIf} />;
  }

  const chosen = view.targets.find((item) => item.alias === target) ?? defaultTarget(view);
  const comparison = chosen ? compareCost(view.traffic.cost, chosen.cost) : null;
  const sourceItems = [
    { id: ALL_MODELS, label: t("allModels") },
    ...view.sources
      .filter((source) => source.model)
      .map((source) => ({
        id: source.model,
        label: source.model,
        detail: t("sourceDetail", { count: source.requests, cost: source.cost }),
      })),
  ];
  const targetItems = view.targets.map((item) => ({
    id: item.alias,
    label: item.alias,
    detail: item.displayName || undefined,
  }));

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle", { days: view.days })} />
      <LoadError state={whatIf} />

      {view.traffic.requests === 0 ? (
        <EmptyState icon={Calculator} title={t("empty", { days: view.days })} description={t("emptyHint")} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <SearchSelect
              label={t("source")}
              items={sourceItems}
              value={view.model || ALL_MODELS}
              onChange={(next) => load(next === ALL_MODELS ? "" : next)}
              isDisabled={pending}
            />
            <SearchSelect
              label={t("target")}
              placeholder={t("targetPlaceholder")}
              items={targetItems}
              value={chosen?.alias ?? ""}
              onChange={setTarget}
              isDisabled={!targetItems.length}
            />
          </div>

          {chosen && comparison ? (
            <div aria-busy={pending} className="space-y-5">
              <Card>
                <Card.Header>
                  <Card.Title className="text-lg font-semibold tracking-tight">
                    {t("verdict", {
                      direction: comparison.direction,
                      all: String(!view.model),
                      target: chosen.alias,
                      source: view.model,
                      share: comparison.share,
                      amount: chosen.cost,
                    })}
                  </Card.Title>
                  <Card.Description>
                    {t("basis", {
                      count: view.traffic.requests,
                      tokens: view.traffic.prompt + view.traffic.completion,
                      since: new Date(view.firstAt ?? view.since),
                    })}
                  </Card.Description>
                </Card.Header>
                <Card.Content>
                  <p className="text-sm text-muted">{t("method")}</p>
                </Card.Content>
              </Card>

              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard label={t("metrics.billed")} value={format.number(view.traffic.cost, "money")} />
                <StatCard
                  label={t("metrics.simulated", { target: chosen.alias })}
                  value={format.number(chosen.cost, "money")}
                />
                <StatCard
                  label={t("metrics.difference")}
                  value={t("difference", {
                    direction: comparison.direction,
                    amount: Math.abs(comparison.difference),
                  })}
                />
              </div>

              <TargetTable
                targets={view.targets}
                billed={view.traffic.cost}
                source={view.model}
                selected={chosen.alias}
                onSelect={setTarget}
              />
            </div>
          ) : (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{t("noTargets")}</Alert.Title>
                <Alert.Description>
                  {t.rich("noTargetsHint", {
                    link: (chunks) => (
                      <Link href="/models" className="text-accent">
                        {chunks}
                      </Link>
                    ),
                    catalog: (chunks) => (
                      <Link href="/model-catalog" className="text-accent">
                        {chunks}
                      </Link>
                    ),
                  })}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
