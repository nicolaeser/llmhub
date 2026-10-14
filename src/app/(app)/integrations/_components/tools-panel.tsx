"use client";

import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Chip, Description, Input, Label, ListBox, Select, TextArea, TextField, useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { EndpointView, ToolView } from "@/types/integrations";
import {
  addManualEndpointAction,
  deprecateToolAction,
  explainToolAction,
  previewAccessAction,
  publishToolAction,
  requestToolApprovalAction,
  rollbackToolAction,
  saveIntegrationToolAction,
  setEndpointSelectionAction,
  validateToolAction,
} from "../_action";
import { graphFor, policyFor } from "./graph";
import type { PanelProps } from "./panel";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export default function ToolsPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const manual = useOverlayState();
  const publish = useOverlayState();
  const [pending, setPending] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerKey, setOwnerKey] = useState("");
  const [operationId, setOperationId] = useState("");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [notice, setNotice] = useState("");
  const [explanation, setExplanation] = useState("");
  const [publishTool, setPublishTool] = useState<ToolView | null>(null);
  const [agentId, setAgentId] = useState(page.agents[0]?.id ?? "");
  const [preview, setPreview] = useState("");

  const owners = useMemo(() => {
    const rows = [
      ...page.integrations.map((row) => ({ key: `company:${row.id}`, label: row.name, owner: "company" as const, ownerId: row.id })),
      ...(page.platform ? page.blueprints.map((row) => ({ key: `blueprint:${row.id}`, label: row.name, owner: "blueprint" as const, ownerId: row.id })) : []),
    ];
    return rows;
  }, [page.blueprints, page.integrations, page.platform]);

  const chosen = page.endpoints.filter((endpoint) => picked.includes(endpoint.id));
  const graph = chosen.length ? graphFor(chosen) : null;

  async function run(action: Promise<unknown>, close?: () => void) {
    setPending(true);
    const result = await action;
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    onPage(result as PanelProps["page"]);
    close?.();
  }

  async function saveTool() {
    if (!chosen.length) return;
    const keys = new Set(chosen.map((endpoint) => endpoint.companyIntegrationId || `blueprint:${endpoint.blueprintId}`));
    if (keys.size > 1) {
      setNotice(t("tools.sameOwner"));
      return;
    }
    setNotice("");
    const first = chosen[0];
    const owner = first.companyIntegrationId ? "company" : "blueprint";
    const ownerId = first.companyIntegrationId || first.blueprintId;
    await run(saveIntegrationToolAction({
      owner,
      ownerId,
      name,
      description,
      kind: chosen.length > 1 ? "workflow" : "operation",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      graph: graphFor(chosen),
      executionPolicy: policyFor(chosen),
    }));
  }

  async function explain(toolId: string) {
    setPending(true);
    const result = await explainToolAction(toolId);
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    setExplanation(result.explanation);
  }

  async function previewPublish() {
    if (!publishTool || !agentId) return;
    setPending(true);
    const result = await previewAccessAction(agentId, publishTool.id);
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    setPreview(result.decision.decision);
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t("tools.endpoints")}</h2>
          {page.canManage ? <Button size="sm" variant="secondary" onPress={() => manual.open()}>{t("tools.manual")}</Button> : null}
        </div>
        {page.endpoints.length === 0 ? <p className="text-sm text-muted">{t("tools.empty")}</p> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {page.endpoints.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              picked={picked.includes(endpoint.id)}
              canManage={page.canManage}
              pending={pending}
              onPick={(on) => setPicked((current) => on ? [...current, endpoint.id] : current.filter((id) => id !== endpoint.id))}
              onToggle={() => run(setEndpointSelectionAction({ id: endpoint.id, enabled: !endpoint.enabled }))}
            />
          ))}
        </div>
      </section>
      {page.canManage ? (
        <Card className="gap-3">
          <Card.Header>
            <Card.Title>{t("tools.build")}</Card.Title>
            <Card.Description>{notice}</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <TextField fullWidth isRequired value={name} onChange={setName}>
              <Label>{t("tools.name")}</Label>
              <Input />
            </TextField>
            <TextField fullWidth value={description} onChange={setDescription}>
              <Label>{t("tools.description")}</Label>
              <TextArea />
            </TextField>
            {graph ? (
              <div className="flex flex-wrap gap-2">
                {graph.nodes.map((node) => (
                  <Chip key={node.id} size="sm">{t("tools.nodes", { node: node.type })}</Chip>
                ))}
              </div>
            ) : null}
          </Card.Content>
          <Card.Footer>
            <Button onPress={() => void saveTool()} isDisabled={pending || !chosen.length || !name.trim()}>{t("tools.save")}</Button>
          </Card.Footer>
        </Card>
      ) : null}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("tools.registry")}</h2>
        {explanation ? <p className="text-sm text-muted">{explanation}</p> : null}
        <div className="grid gap-3">
          {page.tools.map((tool) => (
            <Card key={tool.id} className="gap-2">
              <Card.Header>
                <Card.Title>{tool.name}</Card.Title>
                <Card.Description>{tool.description}</Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{t("status", { status: tool.status })}</Chip>
                <Chip size="sm" variant="soft">{t("tools.version", { version: tool.version, published: tool.publishedVersion })}</Chip>
                {tool.graph.nodes.map((node) => (
                  <Chip key={`${tool.id}-${node.id}`} size="sm" variant="soft">{t("tools.nodes", { node: node.type })}</Chip>
                ))}
              </Card.Content>
              <Card.Footer className="flex flex-wrap gap-2">
                <Button size="sm" variant="tertiary" onPress={() => void explain(tool.id)}>{t("tools.explain")}</Button>
                {page.canManage ? <Button size="sm" variant="secondary" onPress={() => run(validateToolAction({ toolId: tool.id }))}>{t("tools.validate")}</Button> : null}
                {page.canPublish ? <Button size="sm" variant="secondary" onPress={() => run(requestToolApprovalAction({ toolId: tool.id }))}>{t("tools.approve")}</Button> : null}
                {page.canPublish ? (
                  <Button size="sm" onPress={() => { setPublishTool(tool); setPreview(""); publish.open(); }}>{t("tools.publish")}</Button>
                ) : null}
                {page.canPublish && tool.status === "published" ? (
                  <Button size="sm" variant="danger" onPress={() => run(deprecateToolAction({ toolId: tool.id }))}>{t("tools.deprecate")}</Button>
                ) : null}
                {page.canPublish ? tool.rollbackVersions.filter((version) => version !== tool.publishedVersion).map((version) => (
                  <Button key={version} size="sm" variant="tertiary" onPress={() => run(rollbackToolAction({ toolId: tool.id, version }))}>
                    {t("tools.rollback", { version })}
                  </Button>
                )) : null}
              </Card.Footer>
            </Card>
          ))}
        </div>
      </section>
      <FormDialog state={manual} title={t("tools.manual")} submitLabel={t("tools.save")} pending={pending} onSubmit={(close) => {
        const owner = owners.find((row) => row.key === ownerKey) ?? owners[0];
        if (!owner) return;
        void run(addManualEndpointAction({ owner: owner.owner, ownerId: owner.ownerId, operationId, method, path, enabled: false }), close);
      }}>
        <Select selectedKey={ownerKey || owners[0]?.key} onSelectionChange={(key) => setOwnerKey(String(key))} aria-label={t("catalog.company")}>
          <Label>{t("catalog.company")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {owners.map((row) => <ListBox.Item key={row.key} id={row.key} textValue={row.label}>{row.label}</ListBox.Item>)}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField fullWidth isRequired value={operationId} onChange={setOperationId}>
          <Label>{t("tools.operation")}</Label>
          <Input />
          <Description>{t("tools.operation")}</Description>
        </TextField>
        <Select selectedKey={method} onSelectionChange={(key) => setMethod(String(key))} aria-label={t("tools.method")}>
          <Label>{t("tools.method")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {METHODS.map((item) => <ListBox.Item key={item} id={item} textValue={item}>{item}</ListBox.Item>)}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField fullWidth isRequired value={path} onChange={setPath}>
          <Label>{t("tools.path")}</Label>
          <Input />
        </TextField>
      </FormDialog>
      <FormDialog state={publish} title={t("tools.publish")} description={t("access.providerNote")} submitLabel={t("tools.publish")} pending={pending} isSubmitDisabled={page.agents.length > 0 && !preview} onSubmit={(close) => {
        if (!publishTool) return;
        void run(publishToolAction({ toolId: publishTool.id }), close);
      }}>
        {page.agents.length ? (
          <Select selectedKey={agentId} onSelectionChange={(key) => { setAgentId(String(key)); setPreview(""); }} aria-label={t("access.agents")}>
            <Label>{t("access.agents")}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                {page.agents.map((agent) => <ListBox.Item key={agent.id} id={agent.id} textValue={agent.name}>{agent.name}</ListBox.Item>)}
              </ListBox>
            </Select.Popover>
          </Select>
        ) : <p className="text-sm text-muted">{t("access.policyHint")}</p>}
        <Button type="button" variant="secondary" onPress={() => void previewPublish()} isDisabled={!agentId}>{t("access.preview")}</Button>
        {preview ? <p className="text-sm">{t("access.decision", { decision: preview })}</p> : null}
      </FormDialog>
    </div>
  );
}

function EndpointCard({
  endpoint,
  picked,
  canManage,
  pending,
  onPick,
  onToggle,
}: {
  endpoint: EndpointView;
  picked: boolean;
  canManage: boolean;
  pending: boolean;
  onPick: (on: boolean) => void;
  onToggle: () => void;
}) {
  const t = useTranslations("Integrations");
  return (
    <Card className="gap-2">
      <Card.Header>
        <Card.Title>{endpoint.method} {endpoint.path}</Card.Title>
        <Card.Description>{endpoint.summary || endpoint.operationId}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-wrap items-center gap-2">
        <Chip size="sm">{t("effect", { effect: endpoint.sideEffect })}</Chip>
        <Chip size="sm" variant="soft">{endpoint.origin}</Chip>
        {canManage ? (
          <Checkbox isSelected={picked} isDisabled={pending} onChange={onPick} aria-label={t("tools.build")}>
            <Checkbox.Content>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Label>{t("tools.build")}</Label>
            </Checkbox.Content>
          </Checkbox>
        ) : null}
      </Card.Content>
      {canManage ? (
        <Card.Footer>
          <Button size="sm" variant="tertiary" onPress={onToggle}>{t("tools.enable")}</Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
