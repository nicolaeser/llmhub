"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
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
import { SearchX, Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { MAX_HOSTED_TOOLS, MCP_ACTIONS, MCP_BUILDER_TEMPLATES, MCP_ROLE_KEYS } from "@/schemas/mcp";
import type {
  HostedTool,
  McpAssignmentView,
  McpBuilderModel,
  McpBuilderTemplate,
  McpDocsFileRow,
  McpDocsLinkRow,
  McpDocsSourceRef,
  McpDraft,
  McpServerView,
  McpToolAction,
} from "@/types/mcp";
import { createHostedMcpServerAction, setBuilderModelAction } from "../_action";
import BuilderAccess from "./builder-access";
import BuilderSources, { sourcesReady } from "./builder-sources";

const STEPS = ["brief", "review", "access"] as const;
const SEARCH_FROM = 8;
type StepId = (typeof STEPS)[number];

function problemOf(body: unknown): { code: string; pointer: string } {
  const record = body && typeof body === "object" ? (body as { code?: unknown; errors?: unknown }) : {};
  const code = typeof record.code === "string" && record.code ? record.code : "REQUEST_FAILED";
  const first = Array.isArray(record.errors) ? (record.errors[0] as { pointer?: unknown } | undefined) : undefined;
  return {
    code: code === "PAYLOAD_TOO_LARGE" ? "MCP_BUILDER_FILES_SIZE" : code,
    pointer: typeof first?.pointer === "string" ? first.pointer : "",
  };
}

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
  const format = useFormatter();
  const showError = useErrorToast();
  const initial = t("builder.templateText", { template: "readonly" });
  const [step, setStep] = useState<StepId>("brief");
  const [template, setTemplate] = useState<McpBuilderTemplate>("readonly");
  const [instruction, setInstruction] = useState(initial);
  const [docs, setDocs] = useState("");
  const [links, setLinks] = useState<McpDocsLinkRow[]>([]);
  const [files, setFiles] = useState<McpDocsFileRow[]>([]);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
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
  const [search, setSearch] = useState("");
  const [shared, setShared] = useState(false);
  const [global, setGlobal] = useState(false);
  const [rules, setRules] = useState<McpAssignmentView[]>([]);
  const [savingModel, startModel] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const pending = savingModel || drafting || saving;
  const selected = models.some((item) => item.alias === model) ? model : null;
  const chosen = tools.filter((tool) => enabled.includes(tool.name));
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? tools.filter((tool) => [tool.name, tool.title, tool.path].some((value) => value.toLowerCase().includes(needle)))
    : tools;
  const baseValid = /^https?:\/\/[^\s/]+/i.test(baseUrl.trim());
  const tooMany = chosen.length > MAX_HOSTED_TOOLS;
  const headerValid = authType !== "header" || /^[A-Za-z0-9-]{1,64}$/.test(authHeader.trim());
  const needsSecret = authType !== "none" && !shared && !secret.trim();
  const reviewReady = Boolean(name.trim() && baseValid && chosen.length && !tooMany && headerValid && !needsSecret);
  const canDraft = Boolean(instruction.trim()) && sourcesReady(links, docs, files);
  const sourceName = (ref: McpDocsSourceRef) => t("builder.sourceName", { kind: ref.kind, name: ref.name });

  function chooseTemplate(next: McpBuilderTemplate) {
    setTemplate(next);
    if (next !== "custom") setInstruction(t("builder.templateText", { template: next }));
  }

  function editInstruction(value: string) {
    setInstruction(value);
    const match = MCP_BUILDER_TEMPLATES.find(
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
    setEnabled(result.included);
    setSearch("");
    setStep("review");
  }

  function markSource(pointer: string, code: string) {
    const match = /^#\/(links|files)\/(\d+)$/.exec(pointer);
    const rows = match?.[1] === "links" ? links : match?.[1] === "files" ? files : [];
    const key = pointer === "#/docs" ? "docs" : rows[Number(match?.[2])]?.key;
    if (key) setSourceErrors({ [key]: code });
  }

  function runDraft() {
    setSourceErrors({});
    startDraft(async () => {
      const body = new FormData();
      const sent = links.map((row) => ({ url: row.url, internal: row.internal, auth: row.auth, name: row.name, secret: row.secret }));
      body.append("request", JSON.stringify({ template, instruction, docs, links: sent }));
      for (const row of files) body.append("file", row.file, row.file.name);
      let res: Response;
      try {
        res = await fetch("/internal-api/mcp/draft", { method: "POST", body });
      } catch {
        showError("REQUEST_FAILED");
        return;
      }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const problem = problemOf(json);
        markSource(problem.pointer, problem.code);
        if (problem.pointer) setStep("brief");
        showError(problem.code);
        return;
      }
      applyDraft(json as McpDraft);
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
        secret: shared ? "" : secret,
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
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description>{t("builder.modelEmpty")}</Alert.Description>
                            </Alert.Content>
                          </Alert>
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
                            <Description>{t("builder.modelHint")}</Description>
                          </Select>
                        )}
                        <div className="space-y-2">
                          <Label>{t("builder.template")}</Label>
                          <ToggleButtonGroup
                            isDetached
                            className="flex w-full flex-wrap justify-start"
                            selectionMode="single"
                            disallowEmptySelection
                            aria-label={t("builder.template")}
                            selectedKeys={[template]}
                            onSelectionChange={(keys) => {
                              const next = MCP_BUILDER_TEMPLATES.find((item) => item === [...keys][0]);
                              if (next) chooseTemplate(next);
                            }}
                            isDisabled={pending}
                          >
                            {MCP_BUILDER_TEMPLATES.map((item) => (
                              <ToggleButton key={item} id={item}>
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
                        <BuilderSources
                          links={links}
                          docs={docs}
                          files={files}
                          errors={sourceErrors}
                          pending={pending}
                          onLinks={setLinks}
                          onDocs={setDocs}
                          onFiles={setFiles}
                          onErrors={setSourceErrors}
                        />
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
                        {draft.source === "openapi" ? (
                          <Alert status="accent">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Title>{t("builder.imported")}</Alert.Title>
                              <Alert.Description>
                                {draft.importedFrom ? `${t("builder.importedSource", { source: sourceName(draft.importedFrom) })} ` : ""}
                                {t("builder.importedCount", { count: draft.tools.length, total: draft.operations })}
                                {draft.tools.length < draft.operations ? ` ${t("builder.importedLeft", { max: MAX_HOSTED_TOOLS })}` : ""}
                              </Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
                        {draft.unused.length ? (
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description>
                                {t("builder.unusedSources", {
                                  names: format.list(draft.unused.map(sourceName), { type: "conjunction" }),
                                })}
                              </Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
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
                        <TextField
                          fullWidth
                          isRequired
                          value={baseUrl}
                          onChange={setBaseUrl}
                          isDisabled={pending}
                          isInvalid={Boolean(baseUrl.trim()) && !baseValid}
                        >
                          <Label>{t("builder.baseUrl")}</Label>
                          <Input inputMode="url" />
                          {baseUrl.trim() && !baseValid ? (
                            <FieldError>{t("builder.baseInvalid")}</FieldError>
                          ) : (
                            <Description>{t("builder.baseHint")}</Description>
                          )}
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
                        <Switch isSelected={shared} onChange={setShared} isDisabled={pending}>
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <Label>{t("builder.share")}</Label>
                          </Switch.Content>
                          <Description>{t("builder.shareHint")}</Description>
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
                        {authType !== "none" && shared ? <p className="text-sm text-muted">{t("builder.companyKey")}</p> : null}
                        {authType !== "none" && !shared ? (
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
                            <Button size="sm" variant="secondary" isDisabled={pending || !canDraft} onPress={runDraft}>
                              <Sparkles size={14} aria-hidden />
                              {t("builder.redraft")}
                            </Button>
                          </div>
                        </div>
                        <p className="text-sm text-muted">{t("builder.toolsHint")}</p>
                        {tooMany ? (
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description>{t("builder.tooMany", { max: MAX_HOSTED_TOOLS })}</Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
                        {tools.length > SEARCH_FROM ? (
                          <SearchField value={search} onChange={setSearch} aria-label={t("builder.searchTools")} className="w-full">
                            <SearchField.Group>
                              <SearchField.SearchIcon />
                              <SearchField.Input placeholder={t("builder.searchTools")} />
                              <SearchField.ClearButton aria-label={tCommon("close")} />
                            </SearchField.Group>
                          </SearchField>
                        ) : null}
                        {shown.length === 0 ? <EmptyState icon={SearchX} title={t("builder.noMatch")} /> : null}
                        {shown.map((tool) => {
                          const on = enabled.includes(tool.name);
                          return (
                            <Card key={tool.name} variant="secondary">
                              <Card.Content className="gap-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">{tool.title || tool.name}</span>
                                      <Chip size="sm" variant="soft" color={methodColor(tool.method)}>
                                        {tool.method}
                                      </Chip>
                                      <span className="font-mono text-xs break-all text-muted">{tool.path}</span>
                                    </div>
                                    <p className="font-mono text-xs break-all text-muted">{tool.name}</p>
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
                      <BuilderAccess
                        tools={chosen}
                        global={global}
                        rules={rules}
                        pending={pending}
                        onGlobal={setGlobal}
                        onRules={setRules}
                      />
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
                      isDisabled={pending || !canDraft}
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
