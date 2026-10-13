"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  Spinner,
  Switch,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { MCP_AUTH_TYPES } from "@/schemas/mcp";
import type { McpAuthType, McpProbeResult, McpServerView, McpToolSpec } from "@/types/mcp";
import { createMcpServerAction, probeMcpServerAction, updateMcpServerAction } from "../_action";

function initiallyDisabled(server: McpServerView | null): string[] {
  if (!server?.toolsRestricted) return [];
  return server.tools.filter((tool) => !server.allowedTools.includes(tool.name)).map((tool) => tool.name);
}

export default function ServerDialog({
  state,
  editing,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: McpServerView | null;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const showError = useErrorToast();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [internal, setInternal] = useState(editing?.internal ?? false);
  const [authType, setAuthType] = useState<McpAuthType>(editing?.authType ?? "none");
  const [authHeader, setAuthHeader] = useState(editing?.authHeader ?? "");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [tools, setTools] = useState<McpToolSpec[]>(editing?.tools ?? []);
  const [disabled, setDisabled] = useState<string[]>(() => initiallyDisabled(editing));
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();
  const keepsSecret = Boolean(editing?.hasSecret && editing.authType === authType);
  const needsSecret = authType !== "none" && !secret.trim() && !keepsSecret;
  const headerValid = authType !== "header" || /^[A-Za-z0-9-]{1,64}$/.test(authHeader.trim());
  const ready = name.trim() !== "" && url.trim() !== "" && headerValid && !needsSecret;

  function test() {
    startTest(async () => {
      const result = await probeMcpServerAction({
        id: editing?.id,
        url: url.trim(),
        authType,
        authHeader: authHeader.trim(),
        secret,
        internal,
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
    setDisabled((current) => (on ? current.filter((name) => name !== tool) : [...new Set([...current, tool])]));
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
      if (result.server.lastError) toast.danger(t("errors.code", { code: result.server.lastError }));
      close();
    });
  }

  const pending = saving || testing;

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("form.title", { mode: editing ? "edit" : "create", name: editing?.name ?? "" })}
      description={t("form.description")}
      submitLabel={t("form.submit", { mode: editing ? "edit" : "create" })}
      pending={saving}
      isSubmitDisabled={!ready || testing}
      onSubmit={save}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
          <Label>{t("form.name")}</Label>
          <Input />
          <Description>{t("form.nameHint")}</Description>
        </TextField>
        <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
          <Label>{t("form.descriptionField")}</Label>
          <Input />
        </TextField>
      </div>
      <TextField fullWidth isRequired value={url} onChange={setUrl} isDisabled={pending}>
        <Label>{t("form.url")}</Label>
        <Input inputMode="url" placeholder="https://mcp.example.com/mcp" />
        <Description>{t("form.urlHint")}</Description>
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
      <Separator />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          fullWidth
          selectedKey={authType}
          onSelectionChange={(key) => {
            const next = MCP_AUTH_TYPES.find((type) => type === String(key));
            if (next) setAuthType(next);
          }}
          isDisabled={pending}
        >
          <Label>{t("form.authType")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("form.authType")}>
              {MCP_AUTH_TYPES.map((type) => (
                <ListBox.Item key={type} id={type} textValue={t("form.authOption", { type })}>
                  {t("form.authOption", { type })}
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
            isInvalid={authHeader.trim() !== "" && !headerValid}
            isDisabled={pending}
          >
            <Label>{t("form.header")}</Label>
            <Input placeholder="X-Api-Key" />
          </TextField>
        ) : null}
      </div>
      {authType !== "none" ? (
        <TextField fullWidth value={secret} onChange={setSecret} isDisabled={pending} isRequired={!keepsSecret}>
          <Label>{t("form.secret", { type: authType })}</Label>
          <Input type="password" autoComplete="off" placeholder={keepsSecret ? t("form.secretKeep") : ""} />
          <Description>{t("form.secretHint")}</Description>
        </TextField>
      ) : null}
      <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("form.enabled")}</Label>
        </Switch.Content>
        <Description>{t("form.enabledHint")}</Description>
      </Switch>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{t("form.tools")}</p>
          <p className="text-sm text-muted">{t("form.toolsHint")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          isPending={testing}
          isDisabled={!url.trim() || !headerValid || saving}
          onPress={test}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : <PlugZap size={14} aria-hidden />}
              {t("form.test")}
            </>
          )}
        </Button>
      </div>
      {probe ? (
        <Alert status={probe.connected ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {probe.connected
                ? t("form.testOk", { named: String(Boolean(probe.serverName)), name: probe.serverName, count: probe.tools.length })
                : t("form.testFailed")}
            </Alert.Title>
            {probe.connected ? null : <Alert.Description>{t("errors.code", { code: probe.error })}</Alert.Description>}
          </Alert.Content>
        </Alert>
      ) : null}
      {tools.length ? (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {tools.map((tool) => (
            <Card key={tool.name} variant="secondary">
              <Card.Content className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-foreground">{tool.name}</p>
                  {tool.description ? <p className="truncate text-xs text-muted">{tool.description}</p> : null}
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
              </Card.Content>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">{t("form.noTools")}</p>
      )}
    </FormDialog>
  );
}
