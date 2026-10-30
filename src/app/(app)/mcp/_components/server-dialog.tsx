"use client";

import { Fragment, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  Separator,
  Spinner,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import StepDialog from "@/components/console/step-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { authNameValid } from "@/schemas/mcp";
import type { McpAuthType, McpOAuthGrant, McpProbeResult, McpServerView, McpToolSpec } from "@/types/mcp";
import { createMcpServerAction, probeMcpServerAction, updateMcpServerAction } from "../_action";
import ServerAuthFields, { type ServerAuth } from "./server-auth-fields";

function initiallyDisabled(server: McpServerView | null): string[] {
  if (!server?.toolsRestricted) return [];
  return server.tools.filter((tool) => !server.allowedTools.includes(tool.name)).map((tool) => tool.name);
}

function secretNeeded(authType: McpAuthType, grant: McpOAuthGrant): boolean {
  if (authType === "oauth") return grant === "client_credentials";
  return authType !== "none";
}

export default function ServerDialog({
  state,
  editing,
  redirectUri,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: McpServerView | null;
  redirectUri: string;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const showError = useErrorToast();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [internal, setInternal] = useState(editing?.internal ?? false);
  const [auth, setAuth] = useState<ServerAuth>({
    authType: editing?.authType ?? "none",
    authHeader: editing?.authHeader ?? "",
    secret: "",
    oauthGrant: editing?.oauthGrant ?? "authorization_code",
    oauthClientId: editing?.oauthClientId ?? "",
    oauthScopes: editing?.oauthScopes ?? "",
  });
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [tools, setTools] = useState<McpToolSpec[]>(editing?.tools ?? []);
  const [disabled, setDisabled] = useState<string[]>(() => initiallyDisabled(editing));
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();
  const hosted = editing?.kind === "hosted";
  const { authType, authHeader, secret, oauthGrant, oauthClientId, oauthScopes } = auth;
  const keepsSecret = Boolean(editing?.hasSecret && editing.authType === authType);
  const oauth = authType === "oauth";
  const secretRequired = secretNeeded(authType, oauthGrant);
  const needsSecret = secretRequired && !secret.trim() && !keepsSecret;
  const headerValid = authNameValid(authType, authHeader);
  const clientValid = !oauth || oauthGrant !== "client_credentials" || oauthClientId.trim() !== "";
  const serverReady = name.trim() !== "" && url.trim() !== "";
  const authReady = headerValid && clientValid && !needsSecret;
  const signInPending = probe?.error === "MCP_AUTH_REQUIRED" && oauth && oauthGrant === "authorization_code";
  const pending = saving || testing;
  const enabledCount = tools.filter((tool) => !disabled.includes(tool.name)).length;

  function test() {
    startTest(async () => {
      const result = await probeMcpServerAction({
        id: editing?.id,
        url: url.trim(),
        authType,
        authHeader: authHeader.trim(),
        secret,
        internal,
        oauthGrant,
        oauthClientId: oauthClientId.trim(),
        oauthScopes: oauthScopes.trim(),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setProbe(result);
      if (result.connected) setTools(result.tools);
    });
  }

  function toggleTool(tool: string, on: boolean) {
    setDisabled((current) => (on ? current.filter((item) => item !== tool) : [...new Set([...current, tool])]));
  }

  function save(close: () => void) {
    startSave(async () => {
      const off = new Set(disabled);
      const restricted = tools.some((tool) => off.has(tool.name));
      const body = {
        name: name.trim(),
        description: description.trim(),
        url: url.trim(),
        authType,
        authHeader: authHeader.trim(),
        secret,
        clearSecret: false,
        oauthGrant,
        oauthClientId: oauthClientId.trim(),
        oauthScopes: oauthScopes.trim(),
        internal,
        enabled,
        global: editing?.global ?? false,
        toolsRestricted: restricted,
        allowedTools: restricted ? tools.filter((tool) => !off.has(tool.name)).map((tool) => tool.name) : [],
      };
      const result = editing ? await updateMcpServerAction({ id: editing.id, ...body }) : await createMcpServerAction(body);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("form.saved", { mode: editing ? "edit" : "create" }), { variant: "success" });
      if (result.server.status === "signin") toast(t("form.signInNext"));
      else if (result.server.lastError) toast.danger(t("errors.code", { code: result.server.lastError }));
      close();
    });
  }

  const serverStep = (
    <>
      <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
        <Label>{t("form.name")}</Label>
        <Input placeholder={t("form.namePlaceholder")} />
        <Description>{t("form.nameHint")}</Description>
      </TextField>
      <TextField fullWidth isRequired value={url} onChange={setUrl} isDisabled={pending}>
        <Label>{hosted ? t("builder.baseUrl") : t("form.url")}</Label>
        <Input inputMode="url" placeholder={hosted ? "https://api.example.com" : "https://mcp.example.com/mcp"} />
        <Description>{hosted ? t("builder.baseHint") : t("form.urlHint")}</Description>
      </TextField>
      <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
        <Label>{t("form.descriptionField")}</Label>
        <Input />
        <Description>{t("form.descriptionHint")}</Description>
      </TextField>
      <Switch isSelected={internal} onChange={setInternal} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("form.internal")}</Label>
        </Switch.Content>
        <Description>{t("form.internalHint")}</Description>
      </Switch>
    </>
  );

  const toolsStep = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{t("form.tools")}</p>
          {tools.length ? (
            <Chip size="sm" variant="soft">
              {t("allowedCount", { allowed: enabledCount, count: tools.length })}
            </Chip>
          ) : null}
        </div>
        {hosted ? null : (
          <Button
            variant="secondary"
            size="sm"
            isPending={testing}
            isDisabled={!url.trim() || !headerValid || !clientValid || saving}
            onPress={test}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <PlugZap size={14} aria-hidden />}
                {t("form.test")}
              </>
            )}
          </Button>
        )}
      </div>
      {probe && signInPending ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("form.oauthReady")}</Alert.Title>
            <Alert.Description>{t("form.oauthReadyHint")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : probe ? (
        <Alert status={probe.connected ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {probe.connected
                ? t("form.testOk", { named: String(Boolean(probe.serverName)), name: probe.serverName, count: probe.tools.length })
                : t("form.testFailed")}
            </Alert.Title>
            <Alert.Description>
              {probe.connected
                ? t("protocol", { era: probe.era ?? "unknown", version: probe.protocolVersion })
                : t("errors.code", { code: probe.error })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {tools.length ? (
        <Card variant="secondary" className="max-h-80 overflow-y-auto">
          <Card.Content className="gap-0">
            {tools.map((tool, index) => (
              <Fragment key={tool.name}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-sm break-all text-foreground">{tool.name}</p>
                    {tool.description ? <p className="text-xs break-words text-muted">{tool.description}</p> : null}
                  </div>
                  <Switch
                    size="sm"
                    isSelected={!disabled.includes(tool.name)}
                    onChange={(on) => toggleTool(tool.name, on)}
                    isDisabled={pending}
                    aria-label={t("form.toggleTool", { name: tool.name })}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </div>
              </Fragment>
            ))}
          </Card.Content>
        </Card>
      ) : (
        <p className="text-sm text-muted">{hosted ? t("toolCount", { count: 0 }) : t("form.noTools")}</p>
      )}
      <Separator />
      <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("form.enabled")}</Label>
        </Switch.Content>
        <Description>{t("form.enabledHint")}</Description>
      </Switch>
    </>
  );

  return (
    <StepDialog
      state={state}
      size="lg"
      title={t("form.title", { mode: editing ? "edit" : "create", name: editing?.name ?? "" })}
      description={editing ? undefined : t("form.description")}
      submitLabel={t("form.submit", { mode: editing ? "edit" : "create" })}
      pending={saving}
      isSubmitDisabled={testing}
      onSubmit={save}
      steps={[
        {
          id: "server",
          title: t("form.step", { step: "server" }),
          description: t("form.stepHint", { step: "server" }),
          isValid: serverReady,
          content: serverStep,
        },
        {
          id: "signin",
          title: t("form.step", { step: "signin" }),
          description: t("form.stepHint", { step: "signin" }),
          isValid: authReady,
          content: (
            <ServerAuthFields
              value={auth}
              onChange={(patch) => setAuth((current) => ({ ...current, ...patch }))}
              hosted={hosted}
              keepsSecret={keepsSecret}
              secretRequired={secretRequired}
              headerValid={headerValid}
              redirectUri={redirectUri}
              isDisabled={pending}
            />
          ),
        },
        {
          id: "tools",
          title: t("form.step", { step: "tools" }),
          description: t("form.stepHint", { step: hosted ? "hostedTools" : "tools" }),
          optional: true,
          content: toolsStep,
        },
      ]}
    />
  );
}
