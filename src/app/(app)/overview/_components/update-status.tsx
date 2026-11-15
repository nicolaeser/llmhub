"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { useBuildStatus } from "../../_components/build-status";
import UpdaterActivity from "../../_components/updater-activity";

export default function UpdateStatus() {
  const t = useTranslations("Common.updater");
  const build = useBuildStatus();
  const updater = build?.live?.updater;
  if (!build?.live?.canRead || !updater) return null;

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("dashboardTitle")}</Card.Title>
        <Card.Description>{t("dashboardDescription")}</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-3">
        <UpdaterActivity updater={updater} />
        {updater.issue ? <p className="break-words text-sm text-danger">{t("issue", { issue: updater.issue })}</p> : null}
      </Card.Content>
      {build.live.canManage ? (
        <Card.Footer><Link href="/settings?tab=general" className="text-sm text-accent underline">{t("openSettings")}</Link></Card.Footer>
      ) : null}
    </Card>
  );
}
