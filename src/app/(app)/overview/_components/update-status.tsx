"use client";

import { buttonVariants, Card, Separator } from "@heroui/react";
import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { useBuildStatus } from "../../_components/build-status";
import UpdaterActivity from "../../_components/updater-activity";
import { UpdaterButtons } from "../../_components/updater-controls";
import UpdaterHistory from "../../_components/updater-history";

export default function UpdateStatus() {
  const t = useTranslations("Common.updater");
  const build = useBuildStatus();
  const updater = build?.live?.updater;
  if (!build?.live?.canRead || !updater) return null;
  const canManage = build.live.canManage;

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("dashboardTitle")} className="gap-4">
      <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Card.Title>{t("dashboardTitle")}</Card.Title>
          <Card.Description>{t("dashboardDescription")}</Card.Description>
        </div>
        {canManage ? (
          <Link href="/settings?tab=general" className={buttonVariants({ size: "sm", variant: "ghost" })}>
            <Settings size={14} aria-hidden />
            {t("openSettings")}
          </Link>
        ) : null}
      </Card.Header>
      <Card.Content className="space-y-4">
        <UpdaterActivity updater={updater} />
        {canManage ? <UpdaterButtons updater={updater} onView={build.setUpdater} size="sm" /> : null}
        <Separator />
        <UpdaterHistory updater={updater} />
      </Card.Content>
    </Card>
  );
}
