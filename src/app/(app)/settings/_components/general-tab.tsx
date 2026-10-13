"use client";

import { useState, useTransition } from "react";
import { Chip, toast } from "@heroui/react";
import { RefreshCw, Server, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { SettingSection, SettingSwitch } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { GeneralSettings } from "@/types/settings";
import { loadGeneralSettingsAction, saveGeneralSettingsAction } from "../_action";
import SaveBar from "./save-bar";
import TabState from "./tab-state";

export default function GeneralTab() {
  const t = useTranslations("Settings.general");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<GeneralSettings | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadGeneralSettingsAction);
  const { data: view, setData } = page;

  if (!view) return <TabState state={page} />;

  const settings = draft ?? view.settings;
  const disabled = !view.canManage || pending;
  const update = (patch: Partial<GeneralSettings>) => setDraft({ ...settings, ...patch });
  const envRows = [
    { key: "s3", ok: view.env.s3Keys },
    { key: "oidc", ok: view.env.oidcSecret },
    { key: "smtp", ok: view.env.smtp },
    { key: "redis", ok: view.env.redis },
  ] as const;

  function save() {
    start(async () => {
      const result = await saveGeneralSettingsAction(settings);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      setDraft(null);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  return (
    <div className="space-y-5">
      <SaveBar description={t("description")} canManage={view.canManage} pending={pending} onSave={save} />

      <SettingSection title={t("access.title")} subtitle={t("access.subtitle")}>
        <div className="flex items-start gap-3">
          <IconTile icon={UserPlus} />
          <SettingSwitch
            label={t("access.registration")}
            isSelected={settings.registration_enabled}
            onChange={(registration_enabled) => update({ registration_enabled })}
            isDisabled={disabled}
            hint={t("access.registrationHint")}
          />
        </div>
      </SettingSection>

      <SettingSection title={t("updates.title")} subtitle={t("updates.subtitle")}>
        <div className="flex items-start gap-3">
          <IconTile icon={RefreshCw} tone={view.updates.available ? "warning" : "accent"} />
          <div className="min-w-0 space-y-3">
            <SettingSwitch
              label={t("updates.enabled")}
              isSelected={settings.update_check}
              onChange={(update_check) => update({ update_check })}
              isDisabled={disabled}
              hint={t("updates.hint")}
            />
            <p className="text-sm text-foreground">
              {t("updates.state", {
                current: view.updates.current,
                latest: view.updates.latest ?? "",
                state: view.updates.available ? "available" : view.updates.latest ? "current" : "unknown",
              })}
            </p>
            {view.updates.available && view.updates.url ? (
              <a
                href={view.updates.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-medium text-accent"
              >
                {t("updates.open")}
              </a>
            ) : null}
          </div>
        </div>
      </SettingSection>

      <SettingSection title={t("env.title")} subtitle={t("env.subtitle")}>
        <div className="flex items-start gap-3">
          <IconTile icon={Server} tone="neutral" />
          <ul className="min-w-0 flex-1 divide-y divide-border">
            <li className="flex flex-wrap items-baseline justify-between gap-2 pb-3 text-sm">
              <span className="text-muted">{t("env.appUrl")}</span>
              <code className="min-w-0 font-mono text-xs break-all">{view.env.appUrl}</code>
            </li>
            {envRows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="text-muted">{t("env.item", { item: row.key })}</span>
                <Chip size="sm" variant="soft" color={row.ok ? "success" : "default"}>
                  {t("env.state", { ready: row.ok ? "true" : "false" })}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted">{t("env.hint")}</p>
      </SettingSection>
    </div>
  );
}
