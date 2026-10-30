"use client";

import { Description, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { MCP_AUTH_TYPES, MCP_OAUTH_GRANTS, authUsesName } from "@/schemas/mcp";
import type { McpAuthType, McpOAuthGrant } from "@/types/mcp";

export type ServerAuth = {
  authType: McpAuthType;
  authHeader: string;
  secret: string;
  oauthGrant: McpOAuthGrant;
  oauthClientId: string;
  oauthScopes: string;
};

export default function ServerAuthFields({
  value,
  onChange,
  hosted,
  keepsSecret,
  secretRequired,
  headerValid,
  redirectUri,
  isDisabled,
}: {
  value: ServerAuth;
  onChange: (patch: Partial<ServerAuth>) => void;
  hosted: boolean;
  keepsSecret: boolean;
  secretRequired: boolean;
  headerValid: boolean;
  redirectUri: string;
  isDisabled: boolean;
}) {
  const t = useTranslations("Mcp");
  const { authType, oauthGrant } = value;
  const oauth = authType === "oauth";
  const authTypes = MCP_AUTH_TYPES.filter((type) => (hosted ? type !== "oauth" : type !== "query"));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          fullWidth
          selectedKey={authType}
          onSelectionChange={(key) => {
            const next = MCP_AUTH_TYPES.find((type) => type === String(key));
            if (next) onChange({ authType: next });
          }}
          isDisabled={isDisabled}
        >
          <Label>{t("form.authType")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("form.authType")}>
              {authTypes.map((type) => (
                <ListBox.Item key={type} id={type} textValue={t("form.authOption", { type })}>
                  {t("form.authOption", { type })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{t("form.authHint", { type: authType })}</Description>
        </Select>
        {authUsesName(authType) ? (
          <TextField
            fullWidth
            isRequired
            value={value.authHeader}
            onChange={(authHeader) => onChange({ authHeader })}
            isInvalid={value.authHeader.trim() !== "" && !headerValid}
            isDisabled={isDisabled}
          >
            <Label>{t("form.authName", { type: authType })}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder={t("form.authNamePlaceholder", { type: authType })} />
          </TextField>
        ) : null}
      </div>
      {oauth ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            fullWidth
            selectedKey={oauthGrant}
            onSelectionChange={(key) => {
              const next = MCP_OAUTH_GRANTS.find((grant) => grant === String(key));
              if (next) onChange({ oauthGrant: next });
            }}
            isDisabled={isDisabled}
          >
            <Label>{t("form.grant")}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label={t("form.grant")}>
                {MCP_OAUTH_GRANTS.map((grant) => (
                  <ListBox.Item key={grant} id={grant} textValue={t("form.grantOption", { grant })}>
                    {t("form.grantOption", { grant })}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>{t("form.grantHint", { grant: oauthGrant })}</Description>
          </Select>
          <TextField
            fullWidth
            value={value.oauthClientId}
            onChange={(oauthClientId) => onChange({ oauthClientId })}
            isRequired={oauthGrant === "client_credentials"}
            isDisabled={isDisabled}
          >
            <Label>{t("form.clientId")}</Label>
            <Input autoComplete="off" />
            <Description>{t("form.clientIdHint", { grant: oauthGrant })}</Description>
          </TextField>
        </div>
      ) : null}
      {authType !== "none" ? (
        <TextField
          fullWidth
          value={value.secret}
          onChange={(secret) => onChange({ secret })}
          isDisabled={isDisabled}
          isRequired={secretRequired && !keepsSecret}
        >
          <Label>{t("form.secret", { type: authType })}</Label>
          <Input type="password" autoComplete="off" placeholder={keepsSecret ? t("form.secretKeep") : ""} />
          <Description>{t("form.secretHint", { type: authType })}</Description>
        </TextField>
      ) : null}
      {oauth ? (
        <TextField fullWidth value={value.oauthScopes} onChange={(oauthScopes) => onChange({ oauthScopes })} isDisabled={isDisabled}>
          <Label>{t("form.scopes")}</Label>
          <Input autoComplete="off" placeholder="files:read files:write" />
          <Description>{t("form.scopesHint")}</Description>
        </TextField>
      ) : null}
      {oauth && oauthGrant === "authorization_code" && redirectUri ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="min-w-0 space-y-1">
            <p className="text-muted">{t("form.redirectUri")}</p>
            <code className="min-w-0 font-mono text-xs break-all text-foreground">{redirectUri}</code>
          </div>
          <CopyButton text={redirectUri} label={t("form.copyRedirectUri")} />
        </div>
      ) : null}
    </>
  );
}
