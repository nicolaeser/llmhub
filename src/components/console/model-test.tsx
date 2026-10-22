"use client";

import { useState, useTransition } from "react";
import { Button, Chip, Spinner } from "@heroui/react";
import { FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";
import { InternalBadge } from "@/components/console/subscription-badge";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ModelChoice } from "@/lib/models/model-role";
import type { ActionFail } from "@/types/actions";
import type { PickerItem } from "@/types/console";
import type { FeatureModelChoice, FeatureModelTest } from "@/types/models";

export function internalAliases(models: readonly FeatureModelChoice[]): ReadonlySet<string> {
  return new Set(models.filter((model) => model.internal).map((model) => model.alias));
}

export function modelPickerItem(model: ModelChoice, internal: ReadonlySet<string>): PickerItem {
  return {
    id: model.alias,
    label: model.label,
    detail: model.label === model.alias ? undefined : model.alias,
    badge: internal.has(model.alias) ? <InternalBadge /> : undefined,
  };
}

export default function ModelTestButton({
  model,
  test,
  isDisabled,
}: {
  model: string;
  test: (model: string) => Promise<FeatureModelTest | ActionFail>;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Common.modelTest");
  const showError = useErrorToast();
  const [outcome, setOutcome] = useState<{ requested: string; result: FeatureModelTest } | null>(null);
  const [pending, start] = useTransition();
  const result = outcome?.requested === model ? outcome.result : null;

  function run() {
    start(async () => {
      const next = await test(model);
      if (isActionFail(next)) {
        showError(next.error);
        return;
      }
      setOutcome({ requested: model, result: next });
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" isPending={pending} isDisabled={isDisabled} onPress={run}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <FlaskConical size={14} aria-hidden />}
            {t("run")}
          </>
        )}
      </Button>
      {result ? (
        <output aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <Chip size="sm" variant="soft" color={result.ok ? "success" : "danger"}>
            {t("state", { ok: result.ok ? "true" : "false" })}
          </Chip>
          <span className="break-words text-muted">
            {t("detail", { model: result.model, ms: result.latencyMs, status: result.status })}
          </span>
          {result.error ? <span className="break-words text-danger">{result.error}</span> : null}
        </output>
      ) : null}
    </div>
  );
}
