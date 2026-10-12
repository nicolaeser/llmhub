"use client";

import { useState, useTransition } from "react";
import { Card, Chip, Description, Label, ListBox, Select, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { saveAccountRoutingAction } from "@/app/(app)/subscriptions/_action";
import { ACCOUNT_STRATEGIES, DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { isActionFail } from "@/lib/http/action-result";
import type { AccountRouting, AccountStrategy } from "@/types/providers";

const KINDS = PROVIDER_CATALOG.flatMap((spec) => (isSignInKind(spec.kind) ? [spec.kind] : []));

export default function RoutingPanel({
  counts,
  routing,
  onSaved,
}: {
  counts: Record<string, number>;
  routing: AccountRouting;
  onSaved: (routing: AccountRouting) => void;
}) {
  const t = useTranslations("Subscriptions.routing");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const [savingKind, setSavingKind] = useState("");
  const [, start] = useTransition();

  function change(kind: string, strategy: AccountStrategy) {
    setSavingKind(kind);
    start(async () => {
      const result = await saveAccountRoutingAction({ kind, strategy });
      setSavingKind("");
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.routing);
      toast(t("saved", { provider: tProviders("kindName", { kind }) }), { variant: "success" });
    });
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {KINDS.map((kind) => {
            const strategy = routing[kind] ?? DEFAULT_ACCOUNT_STRATEGY;
            const count = counts[kind] ?? 0;
            const label = t("label", { provider: tProviders("kindName", { kind }) });
            return (
              <Card key={kind} variant="secondary">
                <Card.Header>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Card.Title>{tProviders("kindName", { kind })}</Card.Title>
                    <Chip size="sm" variant="soft">
                      {t("accounts", { count })}
                    </Chip>
                  </div>
                </Card.Header>
                <Card.Content className="space-y-2">
                  <Select
                    fullWidth
                    selectedKey={strategy}
                    onSelectionChange={(key) => {
                      const next = ACCOUNT_STRATEGIES.find((item) => item === String(key));
                      if (next && next !== strategy) change(kind, next);
                    }}
                    isDisabled={savingKind === kind}
                    aria-label={label}
                  >
                    <Label>{label}</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox aria-label={label}>
                        {ACCOUNT_STRATEGIES.map((item) => (
                          <ListBox.Item key={item} id={item} textValue={t("method", { strategy: item })}>
                            {t("method", { strategy: item })}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                    <Description>{t("hint", { strategy })}</Description>
                  </Select>
                  {count === 1 ? <p className="text-xs text-muted">{t("single")}</p> : null}
                </Card.Content>
              </Card>
            );
          })}
        </div>
      </Card.Content>
    </Card>
  );
}
