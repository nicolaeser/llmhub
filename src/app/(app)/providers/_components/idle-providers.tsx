"use client";

import { Button, Card, Chip } from "@heroui/react";
import { Plus, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import SubscriptionBadge from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import type { ProviderKindSpec, SignInKind } from "@/types/providers";

export default function IdleProviders({
  specs,
  first,
  antigravityReady,
  onConnect,
  onSetUp,
  onWizard,
}: {
  specs: (ProviderKindSpec & { kind: SignInKind })[];
  first: boolean;
  antigravityReady: boolean | null;
  onConnect: (spec: ProviderKindSpec) => void;
  onSetUp: (kind: SignInKind) => void;
  onWizard: () => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");

  return (
    <Card aria-labelledby="subscriptions-connect" className="gap-5">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <IconTile icon={Plus} tone={first ? "accent" : "neutral"} />
          <div className="min-w-0 flex-1">
            <Card.Title id="subscriptions-connect">{t("connectTitle", { first: String(first) })}</Card.Title>
            <Card.Description>{t("remainingHint")}</Card.Description>
          </div>
        </div>
        <Button size="sm" variant={first ? "primary" : "secondary"} onPress={onWizard}>
          <Plus size={14} aria-hidden />
          {t("openWizard")}
        </Button>
      </Card.Header>
      <Card.Content>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {specs.map((spec) => {
            const locked = spec.kind === "antigravity" && antigravityReady === false;
            return (
              <li key={spec.kind} className="min-w-0">
                <Card variant="secondary" className="h-full gap-3">
                  <Card.Header className="flex-row items-start gap-3">
                    <IconTile icon={kindIcon(spec.kind)} tone={locked ? "neutral" : "accent"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Card.Title className="truncate">{tProviders("kindShort", { kind: spec.kind })}</Card.Title>
                        <SubscriptionBadge />
                      </div>
                      <Card.Description className="line-clamp-3">
                        {tProviders("kindDescription", { kind: spec.kind })}
                      </Card.Description>
                    </div>
                  </Card.Header>
                  <Card.Footer
                    className={`mt-auto flex-wrap items-center gap-2 ${locked ? "justify-between" : "justify-end"}`}
                  >
                    {locked ? (
                      <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
                        {t("settings.setupRequired")}
                      </Chip>
                    ) : null}
                    {locked ? (
                      <Button size="sm" variant="secondary" onPress={() => onSetUp(spec.kind)}>
                        <Settings2 size={14} aria-hidden />
                        {t("settings.setUp")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={tProviders("formTitle", { mode: "connect", name: tProviders("kindName", { kind: spec.kind }) })}
                        onPress={() => onConnect(spec)}
                      >
                        <Plus size={14} aria-hidden />
                        {t("idle.connect")}
                      </Button>
                    )}
                  </Card.Footer>
                </Card>
              </li>
            );
          })}
        </ul>
      </Card.Content>
    </Card>
  );
}
