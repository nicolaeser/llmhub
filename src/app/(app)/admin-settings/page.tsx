"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Label, ListBox, Select, Separator, Spinner, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { loadAdminSettingsAction, saveAdminSettingsAction } from "./_action";
import { SettingSection, SettingSwitch, SettingText } from "./_components/fields";
import { ScimSection } from "./_components/scim-section";
import { isActionFail } from "@/lib/http/action-result";
import type { AdminSettings, AdminSettingsView } from "@/types/settings";

const ADDRESSING = ["auto", "path", "virtual-hosted"] as const;

export default function AdminSettingsPage() {
  const t = useTranslations("AdminSettings");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [view, setView] = useState<AdminSettingsView | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    loadAdminSettingsAction().then((res) => {
      if (isActionFail(res)) return;
      setView(res);
      setSettings(res.settings);
    });
  }, []);

  if (!view || !settings) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const disabled = !view.canManage || pending;
  const update = (patch: Partial<AdminSettings>) => setSettings({ ...settings, ...patch });
  const oidc = (patch: Partial<AdminSettings["oidc"]>) => update({ oidc: { ...settings.oidc, ...patch } });
  const s3 = (patch: Partial<AdminSettings["s3"]>) => update({ s3: { ...settings.s3, ...patch } });
  const appUrl = view.appUrl.replace(/\/+$/, "");

  function save() {
    if (!settings) return;
    start(async () => {
      const result = await saveAdminSettingsAction(settings);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setView(result);
      setSettings(result.settings);
      toast(t("saved"), { variant: "success" });
    });
  }

  const envRows = [
    { label: t("env.appUrl"), value: appUrl },
    { label: t("env.s3"), value: t("env.s3State", { ready: view.s3Ready ? "true" : "false" }), ok: view.s3Ready },
    { label: t("env.oidc"), value: t("env.oidcState", { ready: view.oidcEnv ? "true" : "false" }), ok: view.oidcEnv },
    { label: t("env.smtp"), value: t("env.smtpState", { ready: view.smtpEnv ? "true" : "false" }), ok: view.smtpEnv },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          view.canManage ? (
            <Button isPending={pending} onPress={save}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("save")}
                </>
              )}
            </Button>
          ) : undefined
        }
      />

      <SettingSection title={t("access.title")} subtitle={t("access.subtitle")}>
        <SettingSwitch
          label={t("access.registration")}
          isSelected={settings.registration_enabled}
          onChange={(registration_enabled) => update({ registration_enabled })}
          disabled={disabled}
          hint={t("access.registrationHint")}
        />
        <Separator />
        <div className="space-y-4">
          <SettingSwitch
            label={t("sso.enabled")}
            isSelected={settings.oidc.enabled}
            onChange={(enabled) => oidc({ enabled })}
            disabled={disabled}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <SettingText
              label={t("sso.issuer")}
              value={settings.oidc.issuer}
              onChange={(issuer) => oidc({ issuer })}
              disabled={disabled}
              placeholder="https://login.example.com/realms/acme"
            />
            <SettingText
              label={t("sso.clientId")}
              value={settings.oidc.client_id}
              onChange={(client_id) => oidc({ client_id })}
              disabled={disabled}
            />
            <SettingText
              label={t("sso.redirectUrl")}
              value={settings.oidc.redirect_url}
              onChange={(redirect_url) => oidc({ redirect_url })}
              disabled={disabled}
              placeholder={`${appUrl}/sso/callback`}
              hint={t("sso.redirectHint")}
            />
          </div>
          <p className="text-xs text-muted">
            {t("sso.secretHint", { ready: view.oidcEnv ? "true" : "false" })}
          </p>
        </div>
      </SettingSection>

      <SettingSection title={t("assistant.title")} subtitle={t("assistant.subtitle")}>
        <Select
          selectedKey={settings.assistant_model || "none"}
          onSelectionChange={(key) => update({ assistant_model: String(key) === "none" ? "" : String(key) })}
          isDisabled={disabled}
          className="max-w-md"
          fullWidth
        >
          <Label>{t("assistant.model")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("assistant.model")}>
              <ListBox.Item id="none" textValue={t("assistant.none")}>
                {t("assistant.none")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {view.aliases.map((alias) => (
                <ListBox.Item key={alias} id={alias} textValue={alias}>
                  {alias}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </SettingSection>

      <SettingSection title={t("s3.title")} subtitle={t("s3.subtitle")}>
        <SettingSwitch
          label={t("s3.enabled")}
          isSelected={settings.s3.enabled}
          onChange={(enabled) => s3({ enabled })}
          disabled={disabled}
        />
        <div className="grid gap-4 md:grid-cols-2">
          {(["bucket", "region", "endpoint", "prefix", "public_base_url"] as const).map((field) => (
            <SettingText
              key={field}
              label={t("s3.field", { field })}
              value={settings.s3[field]}
              onChange={(value) => s3({ [field]: value })}
              disabled={disabled}
            />
          ))}
          <Select
            selectedKey={settings.s3.addressing}
            onSelectionChange={(key) => s3({ addressing: String(key) as AdminSettings["s3"]["addressing"] })}
            isDisabled={disabled}
            fullWidth
          >
            <Label>{t("s3.field", { field: "addressing" })}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label={t("s3.field", { field: "addressing" })}>
                {ADDRESSING.map((mode) => (
                  <ListBox.Item key={mode} id={mode} textValue={t("s3.addressing", { mode: mode.replace("-", "_") })}>
                    {t("s3.addressing", { mode: mode.replace("-", "_") })}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <SettingSwitch
          label={t("s3.domainBucket")}
          isSelected={settings.s3.domain_bucket}
          onChange={(domain_bucket) => s3({ domain_bucket })}
          disabled={disabled}
        />
        <p className="text-xs text-muted">{t("s3.keysHint")}</p>
      </SettingSection>

      <ScimSection appUrl={appUrl} initiallySet={view.scimTokenSet} canManage={view.canManageScim} />

      <SettingSection title={t("env.title")} subtitle={t("env.subtitle")}>
        <ul className="divide-y divide-border">
          {envRows.map((row) => (
            <li key={row.label} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
              <span className="text-muted">{row.label}</span>
              <span className={row.ok === true ? "text-success" : row.ok === false ? "text-muted" : "text-foreground"}>
                {row.value}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">{t("env.hint")}</p>
      </SettingSection>
    </div>
  );
}
