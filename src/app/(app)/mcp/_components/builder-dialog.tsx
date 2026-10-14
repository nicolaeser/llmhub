"use client";

import { useState, useTransition } from "react";
import { Button, Chip, Description, Input, Label, ListBox, Select, Switch, TextArea, TextField, toast, type useOverlayState } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpBuilderModel, McpDraft, McpServerView, McpToolAction } from "@/types/mcp";
import { createHostedMcpServerAction, draftMcpServerAction, setBuilderModelAction } from "../_action";

const ACTION_COLOR = {
  read: "success",
  write: "warning",
  delete: "danger",
} as const satisfies Record<McpToolAction, "success" | "warning" | "danger">;

export default function BuilderDialog({
  state,
  model,
  models,
  onModel,
  onCreated,
}: {
  state: ReturnType<typeof useOverlayState>;
  model: string;
  models: McpBuilderModel[];
  onModel: (model: string) => void;
  onCreated: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const showError = useErrorToast();
  const [instruction, setInstruction] = useState("");
  const [docs, setDocs] = useState("");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [internal, setInternal] = useState(false);
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("none");
  const [authHeader, setAuthHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState<string[]>([]);
  const [savingModel, startModel] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const pending = savingModel || drafting || saving;
  const selected = models.some((item) => item.alias === model) ? model : null;
  const chosen = draft?.tools.filter((tool) => enabled.includes(tool.name)) ?? [];
  const headerValid = authType !== "header" || /^[A-Za-z0-9-]{1,64}$/.test(authHeader.trim());
  const needsSecret = authType !== "none" && !secret.trim();
  const ready = Boolean(name.trim() && baseUrl.trim() && chosen.length && headerValid && !needsSecret);

  function chooseModel(next: string) {
    startModel(async () => {
      const result = await setBuilderModelAction(next);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onModel(result.model);
    });
  }

  function runDraft() {
    startDraft(async () => {
      const result = await draftMcpServerAction({ instruction, docs });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setDraft(result);
      setName(result.name);
      setDescription(result.description);
      setBaseUrl(result.baseUrl);
      setInternal(result.internal);
      setAuthType(result.authType);
      setAuthHeader(result.authHeader);
      setEnabled(result.tools.map((tool) => tool.name));
    });
  }

  function create(close: () => void) {
    startSave(async () => {
      const result = await createHostedMcpServerAction({
        name,
        description,
        baseUrl,
        internal,
        authType,
        authHeader,
        secret,
        tools: chosen,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onCreated(result.server);
      toast(t("builder.created"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("builder.title")}
      description={t("builder.description")}
      submitLabel={t("builder.create")}
      pending={saving}
      isSubmitDisabled={!ready || drafting}
      onSubmit={create}
    >
      {models.length === 0 ? (
        <p className="text-sm text-muted">{t("builder.modelEmpty")}</p>
      ) : (
        <Select
          fullWidth
          selectedKey={selected}
          onSelectionChange={(key) => {
            const next = models.find((item) => item.alias === String(key))?.alias;
            if (next) chooseModel(next);
          }}
          isDisabled={pending}
        >
          <Label>{t("builder.model")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {models.map((item) => (
                <ListBox.Item key={item.alias} id={item.alias} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      <TextField fullWidth isRequired value={instruction} onChange={setInstruction} isDisabled={pending}>
        <Label>{t("builder.instruction")}</Label>
        <TextArea className="min-h-20" />
        <Description>{t("builder.instructionHint")}</Description>
      </TextField>
      <TextField fullWidth isRequired value={docs} onChange={setDocs} isDisabled={pending}>
        <Label>{t("builder.docs")}</Label>
        <TextArea className="min-h-40 font-mono text-xs" />
      </TextField>
      <Button type="button" variant="secondary" onPress={runDraft} isDisabled={pending || !instruction.trim() || !docs.trim() || !selected}>
        <Sparkles size={14} aria-hidden />
        {t("builder.draft")}
      </Button>
      {draft ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("builder.endpoint")}</p>
          {draft.notes ? <p className="text-sm text-muted">{t("builder.notes", { notes: draft.notes })}</p> : null}
          <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
            <Label>{t("form.name")}</Label>
            <Input />
          </TextField>
          <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
            <Label>{t("form.descriptionField")}</Label>
            <TextArea />
          </TextField>
          <TextField fullWidth isRequired value={baseUrl} onChange={setBaseUrl} isDisabled={pending}>
            <Label>{t("builder.baseUrl")}</Label>
            <Input inputMode="url" />
            <Description>{t("builder.baseHint")}</Description>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              fullWidth
              selectedKey={authType}
              onSelectionChange={(key) => {
                const next = ["none", "bearer", "header"].find((item) => item === String(key));
                if (next === "none" || next === "bearer" || next === "header") setAuthType(next);
              }}
              isDisabled={pending}
            >
              <Label>{t("form.authType")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {(["none", "bearer", "header"] as const).map((type) => (
                    <ListBox.Item key={type} id={type} textValue={t("form.authOption", { type })}>
                      {t("form.authOption", { type })}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            {authType === "header" ? (
              <TextField fullWidth isRequired value={authHeader} onChange={setAuthHeader} isDisabled={pending}>
                <Label>{t("form.header")}</Label>
                <Input placeholder="X-Api-Key" />
              </TextField>
            ) : null}
          </div>
          {authType !== "none" ? (
            <TextField fullWidth isRequired value={secret} onChange={setSecret} isDisabled={pending}>
              <Label>{t("form.secret", { type: authType })}</Label>
              <Input type="password" autoComplete="off" />
              <Description>{t("form.secretHint", { type: authType })}</Description>
            </TextField>
          ) : null}
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t("builder.tools")}</p>
            {draft.tools.map((tool) => {
              const on = enabled.includes(tool.name);
              return (
                <Switch key={tool.name} isSelected={on} isDisabled={pending} onChange={(next) => {
                  setEnabled((current) => next ? [...current, tool.name] : current.filter((name) => name !== tool.name));
                }}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label>{tool.name}</Label>
                        <Chip size="sm" variant="soft" color={ACTION_COLOR[tool.action]}>{t("action", { action: tool.action })}</Chip>
                        <span className="font-mono text-xs text-muted">{t("builder.toolLine", { method: tool.method, path: tool.path })}</span>
                      </div>
                      {tool.description ? <Description>{tool.description}</Description> : null}
                    </div>
                  </Switch.Content>
                </Switch>
              );
            })}
          </div>
        </div>
      ) : null}
    </FormDialog>
  );
}
