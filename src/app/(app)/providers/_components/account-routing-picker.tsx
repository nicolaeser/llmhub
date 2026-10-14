"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Description, Label, Radio, RadioGroup, Separator, Spinner, toast } from "@heroui/react";
import {
  Activity,
  BatteryMedium,
  Hourglass,
  ListOrdered,
  Network,
  Repeat,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { useErrorToast } from "@/components/console/use-error-toast";
import { Link } from "@/i18n/routing";
import { ACCOUNT_STRATEGIES } from "@/lib/gateway/routing/account-access";
import { isActionFail } from "@/lib/http/action-result";
import type { AccountRouting, AccountStrategy } from "@/types/providers";
import { saveAccountRoutingAction } from "../_action";

const GROUPS = [
  { id: "quota", strategies: ["smart", "quota_balanced", "quota_expiring"] },
  { id: "simple", strategies: ["round_robin", "least_inflight", "priority"] },
] as const satisfies readonly { id: string; strategies: readonly AccountStrategy[] }[];

const RECOMMENDED: AccountStrategy = "smart";

const ICONS: Record<AccountStrategy, LucideIcon> = {
  inherit: Network,
  smart: Sparkles,
  quota_balanced: BatteryMedium,
  quota_expiring: Hourglass,
  round_robin: Repeat,
  least_inflight: Activity,
  priority: ListOrdered,
};

export default function AccountRoutingPicker({
  kind,
  strategy,
  accounts,
  onSaved,
}: {
  kind: string;
  strategy: AccountStrategy;
  accounts: number;
  onSaved: (routing: AccountRouting) => void;
}) {
  const t = useTranslations("Subscriptions.routing");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [choice, setChoice] = useState<AccountStrategy | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, start] = useTransition();
  const shown = choice ?? strategy;
  const provider = tProviders("kindName", { kind });

  function change(value: string) {
    const next = ACCOUNT_STRATEGIES.find((item) => item === value);
    if (!next || next === shown) return;
    setChoice(next);
    start(async () => {
      const result = await saveAccountRoutingAction({ kind, strategy: next });
      setChoice(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.routing);
      toast(t("saved", { provider }), { variant: "success" });
    });
  }

  if (accounts < 2 && !expanded) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-center gap-3">
          <IconTile icon={ICONS[shown]} tone="neutral" size="sm" />
          <p className="min-w-0 text-sm text-muted">
            {t("single", { method: t("method", { strategy: shown }) })}
          </p>
        </div>
        <Button size="sm" variant="tertiary" aria-label={t("label", { provider })} onPress={() => setExpanded(true)}>
          {t("choose")}
        </Button>
      </div>
    );
  }

  return (
    <RadioGroup value={shown} onChange={change} isDisabled={saving} aria-label={t("label", { provider })} className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label>{t("title")}</Label>
          <Description>{t("description")}</Description>
        </div>
        {saving ? (
          <output aria-live="polite" aria-label={tCommon("loading")} className="text-accent">
            <Spinner size="sm" color="current" />
          </output>
        ) : null}
      </div>

      {GROUPS.map((group) => (
        <div key={group.id} className="space-y-2">
          <p className="text-xs font-medium text-muted">{t("group", { group: group.id })}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.strategies.map((item) => {
              const selected = item === shown;
              return (
                <Card
                  key={item}
                  variant="secondary"
                  className={selected ? "border border-accent bg-accent/8 p-0" : "border border-transparent p-0"}
                >
                  <Radio value={item} className="mt-0 h-full w-full">
                    <Radio.Content className="h-full w-full items-start gap-3 p-4">
                      <IconTile icon={ICONS[item]} tone={selected ? "accent" : "neutral"} size="sm" />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <Label>{t("method", { strategy: item })}</Label>
                          {item === RECOMMENDED ? (
                            <Badge size="sm" variant="soft" color="accent" className="px-1.5 whitespace-nowrap">
                              {t("recommended")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block text-xs font-normal text-muted">{t("hint", { strategy: item })}</span>
                      </span>
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                    </Radio.Content>
                  </Radio>
                </Card>
              );
            })}
          </div>
        </div>
      ))}

      {shown === "priority" ? (
        <p className="text-xs text-muted">
          {t.rich("priorityNote", {
            link: (chunks) => (
              <Link href="/models?tab=groups" className="font-medium text-accent">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}

      <Separator />

      <Radio value="inherit" className="mt-0">
        <Radio.Content className="items-start gap-3">
          <Radio.Control>
            <Radio.Indicator />
          </Radio.Control>
          <span className="min-w-0 space-y-1">
            <Label>{t("method", { strategy: "inherit" })}</Label>
            <span className="block text-xs font-normal text-muted">{t("hint", { strategy: "inherit" })}</span>
          </span>
        </Radio.Content>
      </Radio>
    </RadioGroup>
  );
}
