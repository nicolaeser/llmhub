"use client";

import { useState } from "react";
import { Button, Card, Chip, Description, Input, Label, ListBox, Select, Switch, TextField, useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { AUTH_METHODS } from "@/types/integrations";
import {
  beginOauthAction,
  checkConnectionAction,
  clientCredentialsAction,
  completeOauthAction,
  revokeCredentialAction,
  saveConnectionAction,
} from "../_action";
import type { IntegrationPage } from "@/types/integrations";
import type { PanelProps } from "./panel";

function isOauthStart(value: unknown): value is { authorizeUrl: string; state: string; page: IntegrationPage } {
  if (!value || typeof value !== "object") return false;
  const row = value as { authorizeUrl?: unknown; state?: unknown };
  return typeof row.authorizeUrl === "string" && typeof row.state === "string";
}

export default function ConnectionsPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const form = useOverlayState();
  const oauth = useOverlayState();
  const [pending, setPending] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [integrationId, setIntegrationId] = useState(page.integrations[0]?.id ?? "");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMethod, setAuthMethod] = useState("bearer");
  const [secret, setSecret] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  const [internal, setInternal] = useState(false);
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthState, setOauthState] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthConnection, setOauthConnection] = useState("");

  async function run(action: Promise<unknown>, close?: () => void) {
    setPending(true);
    const result = await action;
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return null;
    }
    if (result && typeof result === "object" && "page" in result) {
      onPage((result as { page: PanelProps["page"] }).page);
    } else {
      onPage(result as PanelProps["page"]);
    }
    close?.();
    return result;
  }

  function openNew() {
    setConnectionId("");
    setName("");
    setBaseUrl("");
    setSecret("");
    setAuthMethod("bearer");
    setInternal(false);
    form.open();
  }

  return (
    <div className="space-y-4">
      {page.canCredentials ? <Button onPress={openNew}>{t("connections.save")}</Button> : null}
      {page.connections.length === 0 ? <p className="text-sm text-muted">{t("connections.empty")}</p> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {page.connections.map((row) => (
          <Card key={row.id} className="gap-2">
            <Card.Header>
              <Card.Title>{row.name}</Card.Title>
              <Card.Description>{row.integrationName}</Card.Description>
            </Card.Header>
            <Card.Content className="flex flex-wrap gap-2">
              <Chip size="sm">{t("connections.authMethod", { method: row.authMethod })}</Chip>
              <Chip size="sm" variant="soft">{row.status}</Chip>
              <Chip size="sm" variant="soft">{t("connections.hasSecret", { value: row.hasSecret ? "true" : "other" })}</Chip>
              {row.healthError ? <Chip size="sm" color="danger">{row.healthError}</Chip> : null}
            </Card.Content>
            {page.canCredentials ? (
              <Card.Footer className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onPress={() => run(checkConnectionAction(row.id))}>{t("connections.health")}</Button>
                <Button size="sm" variant="danger" onPress={() => run(revokeCredentialAction(row.id))}>{t("connections.revoke")}</Button>
                {row.authMethod === "oauth2" ? (
                  <Button size="sm" onPress={() => {
                    void (async () => {
                      const result = await run(beginOauthAction(row.id));
                      if (!isOauthStart(result)) return;
                      setOauthUrl(result.authorizeUrl);
                      setOauthState(result.state);
                      setOauthCode("");
                      setOauthConnection(row.id);
                      oauth.open();
                    })();
                  }}>{t("connections.oauth")}</Button>
                ) : null}
                {row.authMethod === "oauth2" ? (
                  <Button size="sm" variant="tertiary" onPress={() => run(clientCredentialsAction(row.id))}>{t("connections.client")}</Button>
                ) : null}
              </Card.Footer>
            ) : null}
          </Card>
        ))}
      </div>
      <FormDialog state={form} title={t("connections.title")} submitLabel={t("connections.save")} pending={pending} onSubmit={(close) => {
        void run(saveConnectionAction({
          id: connectionId || undefined,
          companyIntegrationId: integrationId,
          name,
          authMethod,
          baseUrl,
          internal: page.platform ? internal : false,
          secret: secret || undefined,
          headerName: headerName || undefined,
          tokenUrl: tokenUrl || undefined,
          authorizeUrl: authorizeUrl || undefined,
          clientId: clientId || undefined,
          scopes: scopes.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        }), close);
      }}>
        <Select selectedKey={integrationId} onSelectionChange={(key) => setIntegrationId(String(key))} aria-label={t("catalog.company")}>
          <Label>{t("catalog.company")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {page.integrations.map((row) => <ListBox.Item key={row.id} id={row.id} textValue={row.name}>{row.name}</ListBox.Item>)}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField fullWidth isRequired value={name} onChange={setName}>
          <Label>{t("connections.name")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={baseUrl} onChange={setBaseUrl}>
          <Label>{t("connections.baseUrl")}</Label>
          <Input />
        </TextField>
        <Select selectedKey={authMethod} onSelectionChange={(key) => setAuthMethod(String(key))} aria-label={t("connections.auth")}>
          <Label>{t("connections.auth")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {AUTH_METHODS.map((method) => (
                <ListBox.Item key={method} id={method} textValue={t("connections.authMethod", { method })}>
                  {t("connections.authMethod", { method })}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField fullWidth value={secret} onChange={setSecret}>
          <Label>{t("connections.secret")}</Label>
          <Input type="password" />
          <Description>{t("connections.secretHint")}</Description>
        </TextField>
        <TextField fullWidth value={headerName} onChange={setHeaderName}>
          <Label>{t("connections.header")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={tokenUrl} onChange={setTokenUrl}>
          <Label>{t("connections.tokenUrl")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={authorizeUrl} onChange={setAuthorizeUrl}>
          <Label>{t("connections.authorizeUrl")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={clientId} onChange={setClientId}>
          <Label>{t("connections.clientId")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={scopes} onChange={setScopes}>
          <Label>{t("connections.client")}</Label>
          <Input />
        </TextField>
        {page.platform ? (
          <Switch isSelected={internal} onChange={setInternal}>
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <Label>{t("connections.internal")}</Label>
            </Switch.Content>
            <Description>{t("connections.internalHint")}</Description>
          </Switch>
        ) : null}
      </FormDialog>
      <FormDialog state={oauth} title={t("connections.oauth")} description={t("connections.paste")} submitLabel={t("connections.oauthFinish")} pending={pending} onSubmit={(close) => {
        void run(completeOauthAction({ connectionId: oauthConnection, code: oauthCode, state: oauthState }), close);
      }}>
        <p className="text-sm break-all">{oauthUrl}</p>
        <TextField fullWidth isRequired value={oauthCode} onChange={setOauthCode}>
          <Label>{t("connections.oauthCode")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth isRequired value={oauthState} onChange={setOauthState}>
          <Label>{t("connections.oauthState")}</Label>
          <Input />
        </TextField>
      </FormDialog>
    </div>
  );
}
