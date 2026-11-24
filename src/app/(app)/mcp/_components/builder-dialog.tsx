"use client";

import { useState, useTransition } from "react";
import { Button, Modal, Spinner, toast, type useOverlayState } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { normalizeBaseUrl } from "@/lib/mcp/base-url";
import { docsLoginFor } from "@/lib/mcp/docs-login";
import { MAX_HOSTED_TOOLS, authNameValid } from "@/schemas/mcp";
import type {
  HostedTool,
  McpAccessLevel,
  McpAssignmentView,
  McpBuilderModel,
  McpBuilderTemplate,
  McpDocsFileRow,
  McpDocsLinkRow,
  McpDraft,
  McpServerView,
} from "@/types/mcp";
import { createHostedMcpServerAction, setBuilderModelAction } from "../_action";
import BuilderAccess from "./builder-access";
import BuilderBrief from "./builder-brief";
import BuilderReview, { type BuilderServer } from "./builder-review";
import { sourcesReady } from "./builder-sources";

const STEPS = ["brief", "review", "access"] as const;
type StepId = (typeof STEPS)[number];

const EMPTY_SERVER: BuilderServer = {
  name: "",
  description: "",
  baseUrl: "",
  internal: false,
  authType: "none",
  authHeader: "",
  secret: "",
  shared: false,
  loginFrom: null,
};

function problemOf(body: unknown): { code: string; pointer: string } {
  const record = body && typeof body === "object" ? (body as { code?: unknown; errors?: unknown }) : {};
  const code = typeof record.code === "string" && record.code ? record.code : "REQUEST_FAILED";
  const first = Array.isArray(record.errors) ? (record.errors[0] as { pointer?: unknown } | undefined) : undefined;
  return {
    code: code === "PAYLOAD_TOO_LARGE" ? "MCP_BUILDER_FILES_SIZE" : code,
    pointer: typeof first?.pointer === "string" ? first.pointer : "",
  };
}

export default function BuilderDialog({
  state,
  model,
  models,
  canTestModels,
  onModel,
  onCreated,
}: {
  state: ReturnType<typeof useOverlayState>;
  model: string;
  models: McpBuilderModel[];
  canTestModels: boolean;
  onModel: (model: string) => void;
  onCreated: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const initial = t("builder.templateText", { template: "readonly" });
  const [step, setStep] = useState<StepId>("brief");
  const [template, setTemplate] = useState<McpBuilderTemplate>("readonly");
  const [instruction, setInstruction] = useState(initial);
  const [docs, setDocs] = useState("");
  const [address, setAddress] = useState("");
  const [links, setLinks] = useState<McpDocsLinkRow[]>([]);
  const [files, setFiles] = useState<McpDocsFileRow[]>([]);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [server, setServer] = useState<BuilderServer>(EMPTY_SERVER);
  const [tools, setTools] = useState<HostedTool[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [defaultAccess, setDefaultAccess] = useState<McpAccessLevel>("none");
  const [rules, setRules] = useState<McpAssignmentView[]>([]);
  const [savingModel, startModel] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const pending = savingModel || drafting || saving;
  const chosen = tools.filter((tool) => enabled.includes(tool.name));
  const baseValid = /^https?:\/\/[^\s/]+/i.test(normalizeBaseUrl(server.baseUrl));
  const tooMany = chosen.length > MAX_HOSTED_TOOLS;
  const nameValid = authNameValid(server.authType, server.authHeader);
  const needsSecret = server.authType !== "none" && !server.shared && !server.secret.trim();
  const reviewReady = Boolean(server.name.trim() && baseValid && chosen.length && !tooMany && nameValid && !needsSecret);
  const canDraft = Boolean(instruction.trim()) && sourcesReady(links, docs, files);

  function patchServer(patch: Partial<BuilderServer>) {
    setServer((current) => ({ ...current, ...patch }));
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
    const login = docsLoginFor(result.baseUrl, links);
    patchServer({
      name: result.name,
      description: result.description,
      baseUrl: result.baseUrl,
      internal: result.internal,
      authType: login?.authType ?? result.authType,
      authHeader: login ? login.authHeader : result.authHeader,
      ...(login ? { secret: login.secret } : {}),
      loginFrom: login?.link ?? null,
    });
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
      const sent = links.map((row) => ({
        url: row.url,
        internal: row.internal,
        crawl: row.crawl,
        auth: row.auth,
        name: row.name,
        secret: row.secret,
      }));
      body.append("request", JSON.stringify({ template, instruction, docs, links: sent, address }));
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

  function create(close: () => void) {
    startSave(async () => {
      const included = new Set(chosen.map((tool) => tool.name));
      const result = await createHostedMcpServerAction({
        name: server.name,
        description: server.description,
        baseUrl: normalizeBaseUrl(server.baseUrl),
        internal: server.internal,
        authType: server.authType,
        authHeader: server.authHeader,
        secret: server.shared ? "" : server.secret,
        tools: chosen,
        template: server.shared,
        defaultAccess,
        assignments: rules.map((rule) => ({
          scope: rule.scope,
          id: rule.id,
          access: rule.access,
          extraTools: rule.extraTools.filter((id) => included.has(id)),
          blockedTools: rule.blockedTools.filter((id) => included.has(id)),
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
    <Modal.Backdrop isOpen={state.isOpen} onOpenChange={state.setOpen}>
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
                    <BuilderBrief
                      model={model}
                      models={models}
                      canTestModels={canTestModels}
                      template={template}
                      instruction={instruction}
                      address={address}
                      links={links}
                      docs={docs}
                      files={files}
                      sourceErrors={sourceErrors}
                      pending={pending}
                      drafting={drafting}
                      onModel={chooseModel}
                      onTemplate={setTemplate}
                      onInstruction={setInstruction}
                      onAddress={setAddress}
                      onLinks={setLinks}
                      onDocs={setDocs}
                      onFiles={setFiles}
                      onSourceErrors={setSourceErrors}
                    />
                  ) : null}

                  {step === "review" && draft ? (
                    <BuilderReview
                      draft={draft}
                      server={server}
                      baseValid={baseValid}
                      tools={tools}
                      enabled={enabled}
                      chosen={chosen}
                      tooMany={tooMany}
                      search={search}
                      pending={pending}
                      canDraft={canDraft}
                      onServer={patchServer}
                      onTools={setTools}
                      onEnabled={setEnabled}
                      onSearch={setSearch}
                      onRedraft={runDraft}
                    />
                  ) : null}

                  {step === "access" ? (
                    <BuilderAccess
                      tools={chosen}
                      defaultAccess={defaultAccess}
                      rules={rules}
                      pending={pending}
                      onDefaultAccess={setDefaultAccess}
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
  );
}
