"use client";

import { useEffect } from "react";
import { Card, Chip, Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { LoadError } from "@/components/console/page-status";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { useRoleName } from "@/components/security/use-role-name";
import PasswordCard from "./_components/password-card";
import TwoFactorCard from "./_components/two-factor-card";
import PasskeysCard from "./_components/passkeys-card";
import SessionsCard from "./_components/sessions-card";
import ActivityCard from "./_components/activity-card";
import ManagementKeysCard from "./_components/management-keys-card";
import { loadManagementKeysAction, loadSecurityOverviewAction } from "./_action";

export default function AccountPage() {
  const t = useTranslations("Account");
  const roleName = useRoleName();
  const page = useActionData(loadSecurityOverviewAction);
  const keys = useActionData(loadManagementKeysAction);
  const { data: overview, setData: setOverview } = page;
  const { data: managementKeys, setData: setManagementKeys } = keys;

  useEffect(() => {
    let active = true;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      loadSecurityOverviewAction().then((result) => {
        if (active && !isActionFail(result)) setOverview(result);
      });
    }
    const timer = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [setOverview]);

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {page.error && !overview ? (
        <LoadError state={page} />
      ) : !overview ? (
        <div aria-busy className="space-y-5">
          <Skeleton className="h-20 w-full rounded-3xl" />
          <div className="grid gap-5 xl:grid-cols-2">
            <Skeleton className="h-64 w-full rounded-3xl" />
            <Skeleton className="h-64 w-full rounded-3xl" />
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <Card className="flex-row flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {overview.user.username}
              </p>
              <p className="truncate text-sm text-muted">{overview.user.email}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {overview.user.isOwner ? (
                <Chip size="sm" variant="soft" color="accent">
                  {t("owner")}
                </Chip>
              ) : null}
              <Chip size="sm" variant="soft">
                {roleName(
                  overview.user.roleName || overview.user.roleTemplateKey
                    ? { name: overview.user.roleName, templateKey: overview.user.roleTemplateKey }
                    : null,
                )}
              </Chip>
            </div>
          </Card>
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <div className="space-y-5">
              <TwoFactorCard twoFactor={overview.twoFactor} onChange={setOverview} />
              <PasskeysCard
                passkeys={overview.passkeys}
                available={overview.passkeysAvailable}
                onChange={setOverview}
              />
              <PasswordCard changedAt={overview.password.changedAt} onChange={setOverview} />
            </div>
            <div className="space-y-5">
              <SessionsCard sessions={overview.sessions} onChange={setOverview} />
              {managementKeys ? (
                <ManagementKeysCard payload={managementKeys} onChange={setManagementKeys} />
              ) : keys.error ? (
                <LoadError state={keys} />
              ) : (
                <Skeleton className="h-40 w-full rounded-3xl" />
              )}
              <ActivityCard events={overview.events} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
