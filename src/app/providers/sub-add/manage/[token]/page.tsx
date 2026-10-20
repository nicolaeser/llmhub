"use client";

import { use, useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Spinner, toast } from "@heroui/react";
import { Unlink } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import IconTile from "@/components/console/icon-tile";
import { LoadError } from "@/components/console/page-status";
import { ContributionsSkeleton } from "@/app/providers/sub-add/_components/link-skeletons";
import { PlanBadge } from "@/components/console/subscription-badge";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { SubAddAccountView, SubAddContributions } from "@/types/sub-add";
import { loadSubAddContributionsAction, removeSubAddContributionAction } from "./_action";

function accountState(account: SubAddAccountView): "active" | "expired" | "paused" {
  if (account.status !== "active") return "expired";
  return account.enabled ? "active" : "paused";
}

const STATE_COLOR = { active: "success", expired: "warning", paused: "default" } as const;

export default function SubAddManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useTranslations("SubAdd.manage");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const page = useActionData<SubAddContributions>(() => loadSubAddContributionsAction({ manage: token }));
  const [removing, setRemoving] = useState("");
  const [, startRemove] = useTransition();
  const data = page.data;

  function remove(account: SubAddAccountView) {
    setRemoving(account.providerId);
    startRemove(async () => {
      const result = await removeSubAddContributionAction({ manage: token, providerId: account.providerId });
      setRemoving("");
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      page.setData(result);
      toast(t("removed", { name: tProviders("kindShort", { kind: account.kind }) }), { variant: "success" });
    });
  }

  if (!data) {
    if (page.error === null) return <ContributionsSkeleton />;
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        {page.error === "SUB_ADD_UNAVAILABLE" ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("unavailable")}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <LoadError state={page} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
        <p className="text-sm text-muted">
          {t("intro", { named: data.instance ? "true" : "false", instance: data.instance })}
        </p>
      </div>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("listTitle", { count: data.accounts.length })}</Card.Title>
          <Card.Description>{t("listHint")}</Card.Description>
        </Card.Header>
        <Card.Content>
          {data.accounts.length ? (
            <ul className="divide-y divide-border">
              {data.accounts.map((account) => {
                const state = accountState(account);
                const name = tProviders("kindShort", { kind: account.kind });
                return (
                  <li key={account.providerId} className="flex flex-wrap items-center gap-3 py-3">
                    <IconTile icon={kindIcon(account.kind)} tone="neutral" />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium">{name}</p>
                      <p className="text-sm break-all text-muted">
                        {tProviders("signIn.account", {
                          named: account.account ? "true" : "false",
                          account: account.account,
                        })}
                      </p>
                      <p className="text-xs text-muted">
                        {t("addedAt", { date: format.dateTime(new Date(account.addedAt), { dateStyle: "medium" }) })}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <PlanBadge plan={account.plan} />
                      <Chip size="sm" variant="soft" color={STATE_COLOR[state]} className="whitespace-nowrap">
                        {t("state", { state })}
                      </Chip>
                      <ConfirmDialog
                        title={t("removeTitle", { name })}
                        description={t("removeDescription")}
                        confirmLabel={t("remove")}
                        cancelLabel={tCommon("cancel")}
                        pending={removing === account.providerId}
                        onConfirm={() => remove(account)}
                      >
                        <Button
                          size="sm"
                          variant="danger-soft"
                          isPending={removing === account.providerId}
                          aria-label={t("removeLabel", { name, account: account.account })}
                        >
                          {({ isPending }) => (
                            <>
                              {isPending ? <Spinner color="current" size="sm" /> : <Unlink size={14} aria-hidden />}
                              {t("remove")}
                            </>
                          )}
                        </Button>
                      </ConfirmDialog>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t("empty")}</p>
          )}
        </Card.Content>
      </Card>
      <p className="text-xs text-muted">{t("vendorHint")}</p>
    </div>
  );
}
