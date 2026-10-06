"use client";

import { useEffect, useState } from "react";
import { Alert, Card, Chip, Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { isActionFail } from "@/lib/http/action-result";
import { useRoleName } from "@/components/security/use-role-name";
import { useSecurityError } from "@/components/security/use-security-error";
import type { ManagementKeysPayload } from "@/types/management";
import type { SecurityOverview } from "@/types/security";
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
  const errorText = useSecurityError();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [managementKeys, setManagementKeys] = useState<ManagementKeysPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadSecurityOverviewAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        setError(result.error);
        return;
      }
      setOverview(result);
    });
    loadManagementKeysAction().then((result) => {
      if (active && !isActionFail(result)) setManagementKeys(result);
    });
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
  }, []);

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{errorText(error)}</Alert.Description>
          </Alert.Content>
        </Alert>
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
