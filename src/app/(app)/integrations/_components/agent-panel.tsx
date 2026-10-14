"use client";

import { useState } from "react";
import { Button, Card, Chip, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { AgentTurn } from "@/types/integrations";
import { askIntegrationAgentAction } from "../_action";
import type { PanelProps } from "./panel";

export default function AgentPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [spec, setSpec] = useState("");
  const [scope, setScope] = useState(page.platform ? "company" : "company");
  const [orgId, setOrgId] = useState(page.orgId || page.companies[0]?.id || "");
  const [turn, setTurn] = useState<AgentTurn | null>(null);

  async function run() {
    setPending(true);
    const result = await askIntegrationAgentAction({
      message,
      spec: spec.trim() || undefined,
      scope,
      orgId: scope === "company" ? orgId : undefined,
    });
    setPending(false);
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    setTurn(result.turn);
    onPage(result.page);
  }

  return (
    <div className="space-y-4">
      <Card className="gap-3">
        <Card.Header>
          <Card.Title>{t("agent.title")}</Card.Title>
          <Card.Description>{t("agent.hint")}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-3">
          <TextField fullWidth isRequired value={message} onChange={setMessage}>
            <Label>{t("agent.message")}</Label>
            <TextArea className="min-h-24" />
          </TextField>
          <TextField fullWidth value={spec} onChange={setSpec}>
            <Label>{t("agent.spec")}</Label>
            <TextArea className="min-h-40" />
          </TextField>
          <div className="grid gap-3 sm:grid-cols-2">
            {page.platform && page.canPublish ? (
              <Select selectedKey={scope} onSelectionChange={(key) => setScope(String(key))} aria-label={t("scope", { scope: "global" })}>
                <Label>{t("scope", { scope: "global" })}</Label>
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="company" textValue={t("scope", { scope: "company" })}>{t("scope", { scope: "company" })}</ListBox.Item>
                    <ListBox.Item id="global" textValue={t("scope", { scope: "global" })}>{t("scope", { scope: "global" })}</ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            ) : null}
            {scope === "company" && page.platform ? (
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
          </div>
        </Card.Content>
        <Card.Footer>
          {page.canManage ? (
            <Button onPress={() => void run()} isDisabled={pending || !message.trim()}>{t("agent.run")}</Button>
          ) : null}
        </Card.Footer>
      </Card>
      {turn ? (
        <Card className="gap-3">
          <Card.Header>
            <Card.Title>{turn.reused ? t("agent.reused", { name: turn.reused.name }) : t("agent.title")}</Card.Title>
            <Card.Description>{turn.explanation}</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Chip size="sm">{t("status", { status: "draft" })}</Chip>
            </div>
            <h3 className="text-sm font-semibold">{t("agent.checks")}</h3>
            <div className="grid gap-2">
              {turn.checks.map((check) => (
                <div key={check.name} className="flex flex-wrap gap-2">
                  <Chip size="sm">{check.name}</Chip>
                  <Chip size="sm" variant="soft">{t("agent.ran", { ran: check.ran ? "true" : "other" })}</Chip>
                  <Chip size="sm" variant="soft">{t("agent.ok", { ok: check.ok ? "true" : "other" })}</Chip>
                  <span className="text-sm text-muted">{check.detail}</span>
                </div>
              ))}
            </div>
            <h3 className="text-sm font-semibold">{t("agent.assumptions")}</h3>
            {turn.assumptions.map((item) => <p key={item} className="text-sm text-muted">{item}</p>)}
            <h3 className="text-sm font-semibold">{t("agent.limitations")}</h3>
            {turn.limitations.map((item) => <p key={item} className="text-sm text-muted">{item}</p>)}
            <div className="flex flex-wrap gap-2">
              {turn.tools.map((tool) => <Chip key={tool.slug}>{tool.name}</Chip>)}
            </div>
          </Card.Content>
        </Card>
      ) : null}
    </div>
  );
}
