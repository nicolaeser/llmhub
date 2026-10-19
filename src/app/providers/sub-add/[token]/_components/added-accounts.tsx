"use client";

import { Alert, Button, Card, Chip, Surface } from "@heroui/react";
import { Plus, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { PlanBadge } from "@/components/console/subscription-badge";
import { Link } from "@/i18n/routing";
import { subAddManagePath } from "@/lib/http/public-path";
import type { SubAddDone } from "@/types/sub-add";

export default function AddedAccounts({
  added,
  manageUrl,
  manageToken,
  canAddMore,
  onAddAnother,
}: {
  added: SubAddDone[];
  manageUrl: string;
  manageToken: string;
  canAddMore: boolean;
  onAddAnother: () => void;
}) {
  const t = useTranslations("SubAdd.done");
  const tProviders = useTranslations("Providers");
  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("title", { count: added.length })}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content className="gap-4">
        <ul className="space-y-2">
          {added.map((item, index) => (
            <li key={`${item.kind}-${item.account}-${index}`} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{tProviders("kindShort", { kind: item.kind })}</span>
              <span className="min-w-0 break-all text-foreground">
                {tProviders("signIn.account", { named: item.account ? "true" : "false", account: item.account })}
              </span>
              <PlanBadge plan={item.plan} />
              <Chip size="sm" variant="soft" color="success" className="whitespace-nowrap">
                {t("outcome", { outcome: item.outcome })}
              </Chip>
            </li>
          ))}
        </ul>
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("manageTitle")}</Alert.Title>
            <Alert.Description>{t("manageHint")}</Alert.Description>
            <div className="mt-2 flex min-w-0 items-start gap-2">
              <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                <code className="font-mono text-sm break-all">{manageUrl}</code>
              </Surface>
              <CopyButton text={manageUrl} label={t("copy")} variant="secondary" />
            </div>
          </Alert.Content>
        </Alert>
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Link
          href={subAddManagePath(manageToken)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"
        >
          <Settings2 size={14} aria-hidden />
          {t("openManage")}
        </Link>
        {canAddMore ? (
          <Button size="sm" variant="secondary" onPress={onAddAnother} className="ml-auto">
            <Plus size={14} aria-hidden />
            {t("addAnother")}
          </Button>
        ) : (
          <p className="ml-auto text-sm text-muted">{t("full")}</p>
        )}
      </Card.Footer>
    </Card>
  );
}
