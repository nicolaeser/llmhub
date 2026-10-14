"use client";

import { useState } from "react";
import { Button, Card, Chip, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { previewAccessAction, saveAgentAction, saveBindingAction, savePolicyAction } from "../_action";
import type { EffectivePreview } from "@/types/integrations";
import type { PanelProps } from "./panel";

function isPreview(value: unknown): value is EffectivePreview {
  return Boolean(value && typeof value === "object" && "decision" in value && "layers" in value);
}

const READ_ONLY_RULES = [
  { effect: "deny" as const, effects: ["destructive" as const] },
  { effect: "deny" as const, effects: ["sensitive" as const] },
  { effect: "allow" as const, effects: ["read" as const] },
];

export default function AccessPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const [pending, setPending] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [orgId, setOrgId] = useState(page.orgId || page.companies[0]?.id || "");
  const [agentId, setAgentId] = useState(page.agents[0]?.id ?? "");
  const [connectionId, setConnectionId] = useState(page.connections[0]?.id ?? "");
  const [toolId, setToolId] = useState(page.tools.find((tool) => tool.status === "published" || tool.publishedVersion > 0)?.id ?? "");
  const [policyId, setPolicyId] = useState("");
  const [preview, setPreview] = useState("");
  const [layers, setLayers] = useState("");

  async function run(action: Promise<unknown>) {
    setPending(true);
    const result = await action;
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return null;
    }
    if (result && typeof result === "object" && "decision" in result) return result;
    onPage(result as PanelProps["page"]);
    return result;
  }

  async function previewAccess() {
    if (!agentId || !toolId) return;
    const result = await run(previewAccessAction(agentId, toolId));
    if (!isPreview(result)) return;
    setPreview(result.decision.decision);
    setLayers(result.layers.map((layer) => `${layer.name} v${layer.version}`).join(", "));
  }

  const published = page.tools.filter((tool) => tool.status === "published" || tool.publishedVersion > 0);

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("access.agents")}</h2>
        {page.canManage ? (
          <Card className="gap-3">
            <Card.Content className="grid gap-3 sm:grid-cols-2">
              <TextField fullWidth isRequired value={agentName} onChange={setAgentName}>
                <Label>{t("access.agentName")}</Label>
                <Input />
              </TextField>
              {page.platform ? (
                <Select selectedKey={orgId} onSelectionChange={(key) => setOrgId(String(key))} aria-label={t("import.company")}>
                  <Label>{t("import.company")}</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {page.companies.map((company) => (
                        <ListBox.Item key={company.id} id={company.id} textValue={company.alias}>{company.alias}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
            </Card.Content>
            <Card.Footer>
              <Button onPress={() => void run(saveAgentAction({ name: agentName, orgId: page.platform ? orgId : page.orgId }))} isDisabled={pending || !agentName.trim()}>
                {t("access.agentSave")}
              </Button>
            </Card.Footer>
          </Card>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {page.agents.map((agent) => <Chip key={agent.id}>{agent.name}</Chip>)}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("access.policies")}</h2>
        <p className="text-sm text-muted">{t("access.policyHint")}</p>
        {page.canPublish ? (
          <Button variant="secondary" isDisabled={pending} onPress={() => void run(savePolicyAction({
            scope: toolId ? "tool" : "company",
            orgId: page.platform ? orgId : page.orgId,
            toolId: toolId || undefined,
            rules: READ_ONLY_RULES,
          }))}>{t("access.policySave")}</Button>
        ) : null}
        <div className="grid gap-2">
          {page.policies.map((policy) => (
            <Card key={policy.id}>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{policy.scope}</Chip>
                <Chip size="sm" variant="soft">{t("tools.version", { version: policy.version, published: policy.rules.length })}</Chip>
              </Card.Content>
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("access.bindings")}</h2>
        <Card className="gap-3">
          <Card.Content className="grid gap-3 sm:grid-cols-2">
            <Select selectedKey={agentId} onSelectionChange={(key) => { setAgentId(String(key)); setPreview(""); }} aria-label={t("access.agents")}>
              <Label>{t("access.agents")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {page.agents.map((agent) => <ListBox.Item key={agent.id} id={agent.id} textValue={agent.name}>{agent.name}</ListBox.Item>)}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select selectedKey={connectionId} onSelectionChange={(key) => setConnectionId(String(key))} aria-label={t("connections.title")}>
              <Label>{t("connections.title")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {page.connections.map((row) => <ListBox.Item key={row.id} id={row.id} textValue={row.name}>{row.name}</ListBox.Item>)}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select selectedKey={toolId} onSelectionChange={(key) => { setToolId(String(key)); setPreview(""); }} aria-label={t("tools.registry")}>
              <Label>{t("tools.registry")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {published.map((tool) => <ListBox.Item key={tool.id} id={tool.id} textValue={tool.name}>{tool.name}</ListBox.Item>)}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select selectedKey={policyId} onSelectionChange={(key) => setPolicyId(String(key ?? ""))} aria-label={t("access.policies")}>
              <Label>{t("access.policies")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="" textValue={t("access.policyHint")}>{t("access.policyHint")}</ListBox.Item>
                  {page.policies.map((policy) => (
                    <ListBox.Item key={policy.id} id={policy.id} textValue={policy.scope}>{policy.scope}</ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button variant="secondary" onPress={() => void previewAccess()} isDisabled={pending || !agentId || !toolId}>{t("access.preview")}</Button>
            {page.canPublish ? (
              <Button onPress={() => void run(saveBindingAction({
                agentId,
                connectionId,
                toolId,
                policyId: policyId || undefined,
                status: "active",
              }))} isDisabled={pending || !preview || !agentId || !connectionId || !toolId}>{t("access.bind")}</Button>
            ) : null}
          </Card.Footer>
        </Card>
        {preview ? (
          <div className="space-y-1">
            <p className="text-sm">{t("access.decision", { decision: preview })}</p>
            <p className="text-sm text-muted">{layers}</p>
            <p className="text-sm text-muted">{t("access.providerNote")}</p>
          </div>
        ) : null}
        <div className="grid gap-2">
          {page.bindings.map((binding) => (
            <Card key={binding.id}>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{binding.agentName}</Chip>
                <Chip size="sm" variant="soft">{binding.toolName}</Chip>
                <Chip size="sm" variant="soft">{binding.connectionName}</Chip>
                <Chip size="sm">{binding.status}</Chip>
              </Card.Content>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
