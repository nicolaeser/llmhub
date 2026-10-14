"use client";

import { useState } from "react";
import { Button, Card, Chip, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { decideApprovalAction, testPublishedToolAction } from "../_action";
import type { PanelProps } from "./panel";

function isRun(value: unknown): value is { status: string; decision: string; error: string } {
  if (!value || typeof value !== "object") return false;
  const row = value as { status?: unknown; decision?: unknown; error?: unknown };
  return typeof row.status === "string" && typeof row.decision === "string" && typeof row.error === "string";
}

export default function ActivityPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const [pending, setPending] = useState(false);
  const [toolId, setToolId] = useState(page.tools.find((tool) => tool.publishedVersion > 0)?.id ?? "");
  const [connectionId, setConnectionId] = useState(page.connections[0]?.id ?? "");
  const [agentId, setAgentId] = useState(page.agents[0]?.id ?? "");
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState("");

  async function run(action: Promise<unknown>) {
    setPending(true);
    const outcome = await action;
    setPending(false);
    if (isActionFail(outcome)) {
      showError(outcome.error);
      return null;
    }
    if (outcome && typeof outcome === "object" && "status" in outcome && "decision" in outcome) return outcome;
    onPage(outcome as PanelProps["page"]);
    return outcome;
  }

  async function testTool() {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(input) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        showError("VALIDATION");
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      showError("VALIDATION");
      return;
    }
    const outcome = await run(testPublishedToolAction({ toolId, connectionId, agentId, input: parsed }));
    if (!isRun(outcome)) return;
    setResult(`${outcome.status} ${outcome.decision} ${outcome.error}`.trim());
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("activity.approvals")}</h2>
        {page.approvals.length === 0 ? <p className="text-sm text-muted">{t("activity.emptyApprovals")}</p> : null}
        <div className="grid gap-3">
          {page.approvals.map((row) => (
            <Card key={row.id} className="gap-2">
              <Card.Header>
                <Card.Title>{row.kind}</Card.Title>
                <Card.Description>{row.reason || row.subjectId}</Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{row.status}</Chip>
                <Chip size="sm" variant="soft">{row.createdAt}</Chip>
              </Card.Content>
              {page.canPublish && row.status === "pending" ? (
                <Card.Footer className="flex gap-2">
                  <Button size="sm" onPress={() => void run(decideApprovalAction({ id: row.id, decision: "approved" }))}>{t("activity.approve")}</Button>
                  <Button size="sm" variant="danger" onPress={() => void run(decideApprovalAction({ id: row.id, decision: "rejected" }))}>{t("activity.reject")}</Button>
                </Card.Footer>
              ) : null}
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("activity.executions")}</h2>
        {page.executions.length === 0 ? <p className="text-sm text-muted">{t("activity.emptyExecutions")}</p> : null}
        <div className="grid gap-2">
          {page.executions.map((row) => (
            <Card key={row.id}>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{row.status}</Chip>
                <Chip size="sm" variant="soft">{t("access.decision", { decision: row.decision === "allow" || row.decision === "deny" ? row.decision : "other" })}</Chip>
                <Chip size="sm" variant="soft">{t("tools.version", { version: row.toolVersion, published: row.policyVersion })}</Chip>
                <span className="text-sm text-muted">{row.operation}</span>
                {row.error ? <span className="text-sm text-muted">{row.error}</span> : null}
              </Card.Content>
            </Card>
          ))}
        </div>
      </section>
      {page.canManage ? (
        <Card className="gap-3">
          <Card.Header>
            <Card.Title>{t("activity.test")}</Card.Title>
          </Card.Header>
          <Card.Content className="grid gap-3 sm:grid-cols-2">
            <Select selectedKey={toolId} onSelectionChange={(key) => setToolId(String(key))} aria-label={t("tools.registry")}>
              <Label>{t("tools.registry")}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {page.tools.filter((tool) => tool.publishedVersion > 0).map((tool) => (
                    <ListBox.Item key={tool.id} id={tool.id} textValue={tool.name}>{tool.name}</ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select selectedKey={agentId} onSelectionChange={(key) => setAgentId(String(key))} aria-label={t("access.agents")}>
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
            <TextField fullWidth value={input} onChange={setInput}>
              <Label>{t("activity.testInput")}</Label>
              <TextArea />
            </TextField>
          </Card.Content>
          <Card.Footer className="flex flex-col items-start gap-2">
            <Button onPress={() => void testTool()} isDisabled={pending || !toolId || !agentId || !connectionId}>{t("activity.test")}</Button>
            {result ? <p className="text-sm text-muted">{result}</p> : null}
          </Card.Footer>
        </Card>
      ) : null}
    </div>
  );
}
