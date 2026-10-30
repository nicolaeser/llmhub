"use client";

import { useTransition } from "react";
import { Alert, Button, Chip, Spinner, Table, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { roleTemplateKeys } from "@/lib/auth/permissions";
import { isActionFail } from "@/lib/http/action-result";
import type { RoleTemplateKey } from "@/types/auth";
import type { SignInSettingsView } from "@/types/settings";
import { setAppRolesModeAction, startAppRolesCheckAction } from "../_action";
import { SettingSection, SettingSwitch } from "./setting-fields";

export type Detection = "offered" | "absent" | "checking" | "unknown";

const CHECK_STATUS = {
  admin: "success",
  no_admin: "warning",
  other_account: "warning",
  unavailable: "warning",
  failed: "danger",
} as const;

function modeState(on: boolean, detection: Detection, turnsOnWhenSaved: boolean) {
  if (on) return detection === "absent" ? "lost" : "on";
  if (detection !== "offered") return detection;
  return turnsOnWhenSaved ? "first" : "available";
}

export default function ProviderRoles({
  view,
  provider,
  detection,
  dirty,
  turnsOnWhenSaved,
  onSaved,
}: {
  view: SignInSettingsView;
  provider: string;
  detection: Detection;
  dirty: boolean;
  turnsOnWhenSaved: boolean;
  onSaved: (view: SignInSettingsView) => void;
}) {
  const t = useTranslations("Settings.signIn.providerRoles");
  const tRoles = useTranslations("Roles");
  const showError = useErrorToast();
  const [pending, start] = useTransition();
  const on = view.oidc.app_roles;
  const check = view.appRolesCheck;
  const state = modeState(on, detection, turnsOnWhenSaved);
  const showRoles = on || detection === "offered";
  const rows = roleTemplateKeys.map((key) => ({
    key,
    present: view.roles.some((role) => role.templateKey === key),
  }));

  function startCheck() {
    start(async () => {
      const result = await startAppRolesCheckAction();
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      window.location.assign(result.url);
    });
  }

  function setMode(next: boolean) {
    start(async () => {
      const result = await setAppRolesModeAction({ on: next });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result);
      toast(t("toast", { on: next ? "true" : "false", provider }), { variant: "success" });
    });
  }

  function roleName(row: { key: RoleTemplateKey; present: boolean }) {
    if (!row.present) return <span className="text-warning">{t("missing")}</span>;
    return tRoles("templateName", { key: row.key });
  }

  return (
    <SettingSection title={t("title")} subtitle={t("subtitle")}>
      <div className="flex flex-col gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {detection === "checking" ? <Spinner size="sm" color="current" /> : null}
              <Chip size="sm" variant="soft" color={state === "on" ? "success" : state === "lost" ? "warning" : "default"}>
                {t("state", { state })}
              </Chip>
            </div>
            <p className="text-sm text-muted">{t("stateHint", { state, provider })}</p>
          </div>
          {view.canManage && showRoles && state !== "first" ? (
            <div className="space-y-1">
              <SettingSwitch
                label={t("mode", { provider })}
                isSelected={on}
                onChange={setMode}
                isDisabled={dirty || (!on && check?.result !== "admin")}
              />
              <p className="text-xs text-muted">{dirty ? t("saveFirst") : t("consequence", { provider })}</p>
            </div>
          ) : null}
          {view.canManage && state === "available" ? (
            <div className="space-y-3">
              {check ? (
                <Alert status={CHECK_STATUS[check.result]}>
                  <Alert.Indicator />
                  <Alert.Content className="min-w-0">
                    <Alert.Title>{t("check.title", { result: check.result })}</Alert.Title>
                    <Alert.Description className="break-words">
                      {t("check.body", { result: check.result, provider })}
                      {check.email ? ` ${t("check.as", { email: check.email })}` : null}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <p className="text-sm text-muted">{t("check.intro", { provider })}</p>
              )}
              <Button size="sm" variant="secondary" isPending={pending} isDisabled={dirty} onPress={startCheck}>
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : null}
                    {t("check.start", { again: check ? "true" : "false" })}
                  </>
                )}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {showRoles ? (
        <>
          <RowCards label={t("title")}>
            {rows.map((row) => (
              <RowCard
                key={row.key}
                variant="secondary"
                title={<code className="font-mono text-sm">{row.key}</code>}
                details={[
                  { label: t("columns.role"), value: roleName(row) },
                  { label: t("columns.can"), value: tRoles("templateDescription", { key: row.key }), wide: true },
                ]}
              />
            ))}
          </RowCards>
          <Table className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title")}>
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.value")}</Table.Column>
                  <Table.Column>{t("columns.role")}</Table.Column>
                  <Table.Column>{t("columns.can")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Table.Row key={row.key} id={row.key}>
                      <Table.Cell>
                        <code className="font-mono text-sm">{row.key}</code>
                      </Table.Cell>
                      <Table.Cell>{roleName(row)}</Table.Cell>
                      <Table.Cell>
                        <span className="text-sm text-muted">{tRoles("templateDescription", { key: row.key })}</span>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <p className="text-sm text-muted">{t("footer")}</p>
        </>
      ) : null}
    </SettingSection>
  );
}
