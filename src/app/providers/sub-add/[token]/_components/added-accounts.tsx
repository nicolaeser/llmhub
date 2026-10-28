"use client";

import { Alert, Button, Card, Chip } from "@heroui/react";
import { Plus, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ManageLinkField from "@/app/providers/sub-add/_components/manage-link-field";
import ManageLinkRevoke from "@/app/providers/sub-add/_components/manage-link-revoke";
import { PlanBadge } from "@/components/console/subscription-badge";
import { Link } from "@/i18n/routing";
import { subAddManagePath } from "@/lib/http/public-path";
import type { SubAddDone } from "@/types/sub-add";

export default function AddedAccounts({
  added,
  manageable,
  manage,
  unmanaged,
  revoking,
  onRevoke,
  canAddMore,
  onAddAnother,
}: {
  added: SubAddDone[];
  manageable: boolean;
  manage: { token: string; url: string } | null;
  unmanaged: string[];
  revoking: boolean;
  onRevoke: () => void;
  canAddMore: boolean;
  onAddAnother: () => void;
}) {
  const t = useTranslations("SubAdd.done");
  const tManage = useTranslations("SubAdd.manage");
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
              {item.manageToken !== null && unmanaged.includes(item.manageToken) ? (
                <Chip size="sm" variant="soft" color="default" className="whitespace-nowrap">
                  {t("noManage")}
                </Chip>
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content className="min-w-0">
              <Alert.Title>{t("manageTitle")}</Alert.Title>
              <Alert.Description>{t("manageHint")}</Alert.Description>
              <ManageLinkField url={manage.url} copyLabel={t("copy")} />
              <div className="mt-3">
                <ManageLinkRevoke label={t("skipManage")} variant="ghost" pending={revoking} onConfirm={onRevoke} />
              </div>
            </Alert.Content>
          </Alert>
        ) : (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content className="min-w-0">
              <Alert.Title>{t("manageOffTitle", { manageable: String(manageable) })}</Alert.Title>
              <Alert.Description>
                {t("manageOffHint", { manageable: String(manageable) })} {tManage("revokedNext")}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        {manage ? (
          <Link
            href={subAddManagePath(manage.token)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"
          >
            <Settings2 size={14} aria-hidden />
            {t("openManage")}
          </Link>
        ) : null}
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
