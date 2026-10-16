"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { MCP_ACTIONS, MCP_ROLE_KEYS } from "@/schemas/mcp";
import type { HostedTool, McpAssignmentView, McpBuilderModel, McpDraft, McpServerView, McpToolAction } from "@/types/mcp";
import { createHostedMcpServerAction, draftMcpServerAction, setBuilderModelAction } from "../_action";
import BuilderAccess from "./builder-access";

const TEMPLATES = ["readonly", "writes", "full", "custom"] as const;
const STEPS = ["brief", "review", "access"] as const;
type TemplateId = (typeof TEMPLATES)[number];
type StepId = (typeof STEPS)[number];

function methodColor(method: HostedTool["method"]): "success" | "warning" | "danger" {
  if (method === "GET") return "success";
  if (method === "DELETE") return "danger";
  return "warning";
}

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
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const initial = t("builder.templateText", { template: "readonly" });
  const [step, setStep] = useState<StepId>("brief");
  const [template, setTemplate] = useState<TemplateId>("readonly");
  const [instruction, setInstruction] = useState(initial);
  const [docs, setDocs] = useState("");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [internal, setInternal] = useState(false);
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("none");
  const [authHeader, setAuthHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [tools, setTools] = useState<HostedTool[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [shared, setShared] = useState(false);
  const [global, setGlobal] = useState(false);
  const [rules, setRules] = useState<McpAssignmentView[]>([]);
  const [savingModel, startModel] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const pending = savingModel || drafting || saving;
  const selected = models.some((item) => item.alias === model) ? model : null;
  const chosen = tools.filter((tool) => enabled.includes(tool.name));
  const headerValid = authType !== "header" || /^[A-Za-z0-9-]{1,64}$/.test(authHeader.trim());
  const needsSecret = authType !== "none" && !secret.trim();
  const reviewReady = Boolean(name.trim() && baseUrl.trim() && chosen.length && headerValid && !needsSecret);

  function chooseTemplate(next: TemplateId) {
    setTemplate(next);
    if (next !== "custom") setInstruction(t("builder.templateText", { template: next }));
  }

  function editInstruction(value: string) {
    setInstruction(value);
    const match = TEMPLATES.find(
      (item) => item !== "custom" && t("builder.templateText", { template: item }) === value,
    );
    setTemplate(match ?? "custom");
  }

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

  function applyDraft(result: McpDraft) {
    setDraft(result);
    setName(result.name);
    setDescription(result.description);
    setBaseUrl(result.baseUrl);
    setInternal(result.internal);
    setAuthType(result.authType);
    setAuthHeader(result.authHeader);
    setTools(result.tools);
    setEnabled(result.tools.map((tool) => tool.name));
    setStep("review");
  }

  function runDraft() {
    startDraft(async () => {
      const result = await draftMcpServerAction({ instruction, docs });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      applyDraft(result);
    });
  }

  function patchTool(toolName: string, action: McpToolAction) {
    setTools((current) => current.map((tool) => (tool.name === toolName ? { ...tool, action } : tool)));
  }

  function create(close: () => void) {
    startSave(async () => {
      const included = new Set(chosen.map((tool) => tool.name));
      const result = await createHostedMcpServerAction({
        name,
        description,
        baseUrl,
        internal,
        authType,
        authHeader,
        secret,
        tools: chosen,
        template: shared,
        global,
        assignments: rules.map((rule) => ({
          scope: rule.scope,
          id: rule.id,
          mode: rule.mode,
          blockedTools: rule.blockedTools.filter((id) => included.has(id)),
          blockedActions: rule.blockedActions,
          roleKey: rule.mode === "allow" && rule.role && MCP_ROLE_KEYS.includes(rule.role.key as (typeof MCP_ROLE_KEYS)[number]) ? rule.role.key : "",
        })),
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

  const stepIndex = STEPS.indexOf(step);

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            {({ close }) => (
              <>
                <Modal.Header>
                  <Modal.Heading>{t("builder.title")}</Modal.Heading>
                  <p className="text-sm text-muted">{t("builder.description")}</p>
                </Modal.Header>
                <Modal.Body>
                  <div className="flex flex-col gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2" role="group" aria-label={t("builder.stepsLabel")}>
                        {STEPS.map((id, index) => (
                          <Button
                            key={id}
                            size="sm"
                            variant={id === step ? "primary" : "tertiary"}
                            isDisabled={pending || (index > stepIndex && (!draft || (id === "access" && !reviewReady)))}
                            onPress={() => setStep(id)}
                          >
                            {t("builder.step", { step: id })}
                          </Button>
                        ))}
                      </div>
                      <p className="text-sm text-muted">{t("builder.stepHint", { step })}</p>
                    </div>

                    {step === "brief" ? (
                      <>
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
                        <div className="space-y-2">
                          <Label>{t("builder.template")}</Label>
                          <ToggleButtonGroup
                            selectionMode="single"
                            disallowEmptySelection
                            aria-label={t("builder.template")}
                            selectedKeys={[template]}
                            onSelectionChange={(keys) => {
                              const next = TEMPLATES.find((item) => item === [...keys][0]);
                              if (next) chooseTemplate(next);
                            }}
                            isDisabled={pending}
                          >
                            {TEMPLATES.map((item, index) => (
                              <ToggleButton key={item} id={item}>
                                {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                                {t("builder.templateName", { template: item })}
                              </ToggleButton>
                            ))}
                          </ToggleButtonGroup>
                          <Description>{t("builder.templateHint")}</Description>
                        </div>
                        <TextField fullWidth isRequired value={instruction} onChange={editInstruction} isDisabled={pending}>
                          <Label>{t("builder.instruction")}</Label>
                          <TextArea className="min-h-24" />
                          <Description>{t("builder.instructionHint")}</Description>
                        </TextField>
                        <TextField fullWidth isRequired value={docs} onChange={setDocs} isDisabled={pending}>
                          <Label>{t("builder.docs")}</Label>
                          <TextArea className="min-h-40 font-mono text-xs" />
                          <Description>{t("builder.docsHint")}</Description>
                        </TextField>
                        {drafting ? (
                          <output aria-live="polite" className="text-sm text-muted">
                            {t("builder.drafting")}
                          </output>
                        ) : null}
                      </>
                    ) : null}

                    {step === "review" && draft ? (
                      <>
                        <p className="text-sm text-muted">{t("builder.endpoint")}</p>
                        {draft.notes ? (
                          <Alert status="accent">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Title>{t("builder.notesLabel")}</Alert.Title>
                              <Alert.Description>{t("builder.notes", { notes: draft.notes })}</Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
                        <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
                          <Label>{t("form.name")}</Label>
                          <Input />
                          <Description>{t("form.nameHint")}</Description>
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
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-foreground">{t("builder.tools")}</p>
                            <p className="text-sm text-muted">
                              {t("builder.included", { count: chosen.length, total: tools.length })}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => setEnabled(tools.filter((tool) => tool.action === "read").map((tool) => tool.name))}>
                              {t("builder.keepReads")}
                            </Button>
                            <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => setEnabled(tools.filter((tool) => tool.action !== "delete").map((tool) => tool.name))}>
                              {t("builder.dropDeletes")}
                            </Button>
                            <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => setEnabled(tools.map((tool) => tool.name))}>
                              {t("builder.includeAll")}
                            </Button>
                            <Button size="sm" variant="secondary" isDisabled={pending || !instruction.trim() || !docs.trim() || !selected} onPress={runDraft}>
                              <Sparkles size={14} aria-hidden />
                              {t("builder.redraft")}
                            </Button>
                          </div>
                        </div>
                        <p className="text-sm text-muted">{t("builder.toolsHint")}</p>
                        {tools.map((tool) => {
                          const on = enabled.includes(tool.name);
                          return (
                            <Card key={tool.name} variant="secondary">
                              <Card.Content className="gap-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">{tool.title || tool.name}</span>
                                      <Badge size="sm" variant="soft" color={methodColor(tool.method)} className="px-1.5 whitespace-nowrap">
                                        {tool.method}
                                      </Badge>
                                      <span className="font-mono text-xs text-muted">{tool.path}</span>
                                    </div>
                                    <p className="font-mono text-xs text-muted">{tool.name}</p>
                                    {tool.description ? <p className="text-sm text-muted">{tool.description}</p> : null}
                                  </div>
                                  <Switch
                                    isSelected={on}
                                    isDisabled={pending}
                                    aria-label={t("builder.includeTool", { name: tool.name })}
                                    onChange={(next) => {
                                      setEnabled((current) =>
                                        next ? [...current, tool.name] : current.filter((item) => item !== tool.name),
                                      );
                                    }}
                                  >
                                    <Switch.Content>
                                      <Switch.Control>
                                        <Switch.Thumb />
                                      </Switch.Control>
                                    </Switch.Content>
                                  </Switch>
                                </div>
                                <ToggleButtonGroup
                                  size="sm"
                                  selectionMode="single"
                                  disallowEmptySelection
                                  aria-label={t("builder.toolAction", { name: tool.name })}
                                  selectedKeys={[tool.action]}
                                  onSelectionChange={(keys) => {
                                    const next = MCP_ACTIONS.find((item) => item === [...keys][0]);
                                    if (next) patchTool(tool.name, next);
                                  }}
                                  isDisabled={pending}
                                >
                                  {MCP_ACTIONS.map((action, index) => (
                                    <ToggleButton key={action} id={action}>
                                      {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                                      {t("action", { action })}
                                    </ToggleButton>
                                  ))}
                                </ToggleButtonGroup>
                              </Card.Content>
                            </Card>
                          );
                        })}
                      </>
                    ) : null}

                    {step === "access" ? (
                      <>
                      <Switch isSelected={shared} onChange={setShared} isDisabled={pending}>
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          <Label>{t("builder.share")}</Label>
                        </Switch.Content>
                        <Description>{t("builder.shareHint")}</Description>
                      </Switch>
                      <BuilderAccess
                        tools={chosen}
                        global={global}
                        rules={rules}
                        pending={pending}
                        onGlobal={setGlobal}
                        onRules={setRules}
                      />
                      </>
                    ) : null}
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="tertiary" onPress={close} isDisabled={pending}>
                    {tCommon("cancel")}
                  </Button>
                  {step !== "brief" ? (
                    <Button
                      variant="secondary"
                      isDisabled={pending}
                      onPress={() => setStep(step === "access" ? "review" : "brief")}
                    >
                      {t("builder.back")}
                    </Button>
                  ) : null}
                  {step === "brief" ? (
                    <Button
                      variant="primary"
                      onPress={runDraft}
                      isPending={drafting}
                      isDisabled={pending || !instruction.trim() || !docs.trim() || !selected}
                    >
                      {({ isPending }) => (
                        <>
                          {isPending ? <Spinner color="current" size="sm" /> : <Sparkles size={14} aria-hidden />}
                          {t("builder.draft")}
                        </>
                      )}
                    </Button>
                  ) : null}
                  {step === "review" ? (
                    <Button variant="primary" isDisabled={pending || !reviewReady} onPress={() => setStep("access")}>
                      {tCommon("continue")}
                    </Button>
                  ) : null}
                  {step === "access" ? (
                    <Button variant="primary" onPress={() => create(close)} isPending={saving} isDisabled={!reviewReady || drafting}>
                      {({ isPending }) => (
                        <>
                          {isPending ? <Spinner color="current" size="sm" /> : null}
                          {t("builder.create")}
                        </>
                      )}
                    </Button>
                  ) : null}
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
