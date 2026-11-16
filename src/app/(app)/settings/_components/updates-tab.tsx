"use client";

import { useState, useTransition } from "react";
import { Card, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { SettingSection, SettingSwitch } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { UpdaterView } from "@/types/updates";
import { useBuildStatus } from "../../_components/build-status";
import UpdaterActivity from "../../_components/updater-activity";
import { AutoUpdateSwitch, UpdateChimeSwitch, UpdaterButtons } from "../../_components/updater-controls";
import UpdaterHistory from "../../_components/updater-history";
import { UpdaterFacts, UpdaterMissing } from "../../_components/updater-panel";
import { loadGeneralSettingsAction, saveGeneralSettingsAction } from "../_action";
import { SettingsLead } from "./save-bar";
import TabState from "./tab-state";

export default function UpdatesTab() {
  const t = useTranslations("Settings.updates");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [updaterOverride, setUpdaterOverride] = useState<{ view: UpdaterView | null } | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadGeneralSettingsAction);
  const { data: view, setData } = page;
  const live = useBuildStatus();

  if (!view) return <TabState state={page} />;

  const updater = live?.live ? live.live.updater : updaterOverride ? updaterOverride.view : view.updater;
  const showUpdater = (next: UpdaterView | null) => {
    setUpdaterOverride({ view: next });
    live?.setUpdater(next);
  };
  const releases = view.updates;

  function setReleaseCheck(update_check: boolean) {
    if (!view) return;
    start(async () => {
      const result = await saveGeneralSettingsAction({ ...view.settings, update_check });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  return (
    <div className="space-y-8">
      <SettingsLead description={t("description")} canManage={view.canManage} />

      <Card className="gap-5">
        <Card.Content className="space-y-5">
          {updater ? (
            <>
              <UpdaterActivity updater={updater} />
              {view.canManage ? <UpdaterButtons updater={updater} onView={showUpdater} /> : null}
            </>
          ) : (
            <UpdaterMissing withCommand />
          )}
        </Card.Content>
      </Card>

      {updater ? (
        <>
          <SettingSection title={t("automatic.title")} subtitle={t("automatic.subtitle")}>
            <div className="flex flex-col gap-4">
              {view.canManage ? <AutoUpdateSwitch updater={updater} onView={showUpdater} /> : null}
              <UpdateChimeSwitch />
            </div>
          </SettingSection>

          <SettingSection title={t("image.title")} subtitle={t("image.subtitle")}>
            <UpdaterFacts updater={updater} />
          </SettingSection>

          <SettingSection title={t("history.title")} subtitle={t("history.subtitle")}>
            <UpdaterHistory updater={updater} />
          </SettingSection>
        </>
      ) : null}

      <SettingSection title={t("releases.title")} subtitle={t("releases.subtitle")}>
        <div className="min-w-0 space-y-3">
          <SettingSwitch
            label={t("releases.enabled")}
            isSelected={view.settings.update_check}
            onChange={setReleaseCheck}
            isDisabled={!view.canManage || pending}
            hint={t("releases.hint")}
          />
          <p className="text-sm text-foreground">
            {t("releases.state", {
              current: releases.current,
              latest: releases.latest ?? "",
              state: releases.available ? "available" : releases.latest ? "current" : "unknown",
            })}
          </p>
          {releases.available && releases.url ? (
            <a href={releases.url} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-accent">
              {t("releases.open")}
            </a>
          ) : null}
        </div>
      </SettingSection>
    </div>
  );
}
