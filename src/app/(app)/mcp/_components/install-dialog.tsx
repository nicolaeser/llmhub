"use client";

import { useState, useTransition } from "react";
import {
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpInstallationView, McpServerView } from "@/types/mcp";
import { saveMcpInstallationAction, setMcpTemplateAction } from "../_action";

const AUTH = ["none", "bearer", "header"] as const;
type InstallAuth = (typeof AUTH)[number];

function installAuth(value: string | undefined): InstallAuth {
  return value === "none" || value === "header" ? value : "bearer";
}

function headerOk(authType: InstallAuth, authHeader: string): boolean {
  return authType !== "header" || /^[A-Za-z0-9-]{1,64}$/.test(authHeader.trim());
}

function urlOk(baseUrl: string): boolean {
  return baseUrl.trim() === "" || /^https?:\/\//.test(baseUrl.trim());
}

export default function InstallDialog({
  state,
  server,
  companies,
  companyId,
  canManage,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  server: McpServerView | null;
  companies: { id: string; alias: string }[];
  companyId: string | null;
  canManage: boolean;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const initialOrg = companyId || server?.installations[0]?.orgId || companies[0]?.id || "";
  const initial = server?.installations.find((row) => row.orgId === initialOrg) ?? null;
  const [orgId, setOrgId] = useState(initialOrg);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [authType, setAuthType] = useState<InstallAuth>(installAuth(initial?.authType ?? server?.authType));
  const [authHeader, setAuthHeader] = useState(initial?.authHeader ?? "");
  const [secret, setSecret] = useState("");
  const [shared, setShared] = useState(server?.template ?? false);
  const [pending, start] = useTransition();
  const current = server?.installations.find((row) => row.orgId === orgId) ?? null;
  const keepsSecret = Boolean(current?.hasSecret && current.authType === authType);
  const needsSecret = enabled && authType !== "none" && !secret.trim() && !keepsSecret;
  const connect = (canManage ? shared : Boolean(server?.template)) && Boolean(orgId);
  const fieldsOk = headerOk(authType, authHeader) && urlOk(baseUrl) && !needsSecret;
  const templateChanged = Boolean(canManage && server && shared !== server.template);

  function apply(row: McpInstallationView | null, fallback: InstallAuth) {
    setEnabled(row?.enabled ?? true);
    setBaseUrl(row?.baseUrl ?? "");
    setAuthType(installAuth(row?.authType ?? fallback));
    setAuthHeader(row?.authHeader ?? "");
    setSecret("");
  }

  function chooseOrg(next: string) {
    setOrgId(next);
    apply(server?.installations.find((row) => row.orgId === next) ?? null, installAuth(server?.authType));
  }

  function save(close: () => void) {
    if (!server) return;
    start(async () => {
      let latest = server;
      if (canManage && shared && !server.template) {
        const flipped = await setMcpTemplateAction({ id: server.id, template: true });
        if (isActionFail(flipped)) {
          showError(flipped.error);
          return;
        }
        latest = flipped.server;
      }
      if (connect) {
        const saved = await saveMcpInstallationAction({
          serverId: server.id,
          orgId,
          enabled,
          baseUrl: baseUrl.trim(),
          authType,
          authHeader: authHeader.trim(),
          secret,
        });
        if (isActionFail(saved)) {
          showError(saved.error);
          return;
        }
        latest = saved.server;
      }
      if (canManage && !shared && server.template) {
        const flipped = await setMcpTemplateAction({ id: server.id, template: false });
        if (isActionFail(flipped)) {
          showError(flipped.error);
          return;
        }
        latest = flipped.server;
      }
      onSaved(latest);
      toast(t("install.saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("install.title", { name: server?.name ?? "" })}
      description={t("install.description")}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!server || (connect && !fieldsOk) || (!connect && !templateChanged)}
      onSubmit={save}
    >
      {canManage ? (
        <Switch isSelected={shared} onChange={setShared} isDisabled={pending}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("install.template")}</Label>
          </Switch.Content>
          <Description>{t("install.templateHint")}</Description>
        </Switch>
      ) : null}
      {companies.length ? (
        <Select
          fullWidth
          selectedKey={companies.some((company) => company.id === orgId) ? orgId : undefined}
          onSelectionChange={(key) => chooseOrg(String(key))}
          isDisabled={pending || Boolean(companyId) || companies.length === 1}
        >
          <Label>{t("install.company")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("install.company")}>
              {companies.map((company) => (
                <ListBox.Item key={company.id} id={company.id} textValue={company.alias}>
                  {company.alias}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <p className="text-sm text-muted">{t("install.companyEmpty")}</p>
      )}
      <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending || !orgId}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("install.enabled")}</Label>
        </Switch.Content>
        <Description>{t("install.enabledHint")}</Description>
      </Switch>
      <Select
        fullWidth
        selectedKey={authType}
        onSelectionChange={(key) => {
          const next = AUTH.find((item) => item === String(key));
          if (next) setAuthType(next);
        }}
        isDisabled={pending || !orgId}
      >
        <Label>{t("install.authType")}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox aria-label={t("install.authType")}>
            {AUTH.map((item) => (
              <ListBox.Item key={item} id={item} textValue={t("install.authOption", { type: item })}>
                {t("install.authOption", { type: item })}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {authType === "header" ? (
        <TextField
          fullWidth
          isRequired
          value={authHeader}
          onChange={setAuthHeader}
          isInvalid={authHeader.trim() !== "" && !headerOk(authType, authHeader)}
          isDisabled={pending}
        >
          <Label>{t("install.header")}</Label>
          <Input autoComplete="off" placeholder="X-Api-Key" />
        </TextField>
      ) : null}
      {authType !== "none" ? (
        <TextField fullWidth value={secret} onChange={setSecret} isDisabled={pending || !orgId} isRequired={needsSecret}>
          <Label>{t("install.secret", { type: authType })}</Label>
          <Input type="password" autoComplete="off" placeholder={keepsSecret ? t("install.secretKeep") : ""} />
          <Description>{keepsSecret ? t("install.secretKeep") : t("install.secretHint")}</Description>
        </TextField>
      ) : null}
      <TextField fullWidth value={baseUrl} onChange={setBaseUrl} isInvalid={!urlOk(baseUrl)} isDisabled={pending || !orgId}>
        <Label>{t("install.baseUrl")}</Label>
        <Input autoComplete="off" placeholder="https://api.example.com/v1" />
        <Description>{t("install.baseHint")}</Description>
      </TextField>
    </FormDialog>
  );
}
