"use client";

import { useState } from "react";
import { Button, Card, Chip, Description, Input, Label, ListBox, Select, TextArea, TextField, useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import {
  createCompanyDraftAction,
  importIntegrationAction,
  instantiateBlueprintAction,
  setBlueprintVisibilityAction,
} from "../_action";
import type { PanelProps } from "./panel";

export default function CatalogPanel({ page, onPage }: PanelProps) {
  const t = useTranslations("Integrations");
  const showError = useErrorToast();
  const importState = useOverlayState();
  const draftState = useOverlayState();
  const visibilityState = useOverlayState();
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [document, setDocument] = useState("");
  const [target, setTarget] = useState(page.platform ? "blueprint" : "company");
  const [orgId, setOrgId] = useState(page.orgId || page.companies[0]?.id || "");
  const [visibilityId, setVisibilityId] = useState("");
  const [visibility, setVisibility] = useState("internal");
  const [audience, setAudience] = useState("");

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {page.canManage ? (
          <Button onPress={() => importState.open()}>{t("catalog.import")}</Button>
        ) : null}
        {page.canManage ? <Button variant="secondary" onPress={() => draftState.open()}>{t("catalog.create")}</Button> : null}
      </div>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("catalog.global")}</h2>
        {page.blueprints.length === 0 ? <p className="text-sm text-muted">{t("catalog.emptyGlobal")}</p> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {page.blueprints.map((row) => (
            <Card key={row.id} className="gap-3">
              <Card.Header className="gap-2">
                <Card.Title>{row.name}</Card.Title>
                <Card.Description>{row.description}</Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{t("visibility", { visibility: row.visibility })}</Chip>
                <Chip size="sm" variant="soft">{t("catalog.endpoints", { count: row.endpointCount })}</Chip>
                <Chip size="sm" variant="soft">{t("catalog.tools", { count: row.toolCount })}</Chip>
              </Card.Content>
              <Card.Footer className="flex flex-wrap gap-2">
                {page.canManage && (row.visibility === "all" || row.visibility === "selected") ? (
                  <Button
                    size="sm"
                    onPress={() => run(instantiateBlueprintAction({ blueprintId: row.id, orgId: orgId || undefined }))}
                  >
                    {t("catalog.use")}
                  </Button>
                ) : null}
                {page.platform && page.canPublish ? (
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => {
                      setVisibilityId(row.id);
                      setVisibility(row.visibility);
                      setAudience(row.audience.join("\n"));
                      visibilityState.open();
                    }}
                  >
                    {t("catalog.visibilityAction")}
                  </Button>
                ) : null}
              </Card.Footer>
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("catalog.company")}</h2>
        {page.integrations.length === 0 ? <p className="text-sm text-muted">{t("catalog.emptyCompany")}</p> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {page.integrations.map((row) => (
            <Card key={row.id} className="gap-2">
              <Card.Header>
                <Card.Title>{row.name}</Card.Title>
                <Card.Description>
                  {row.blueprintName ? t("catalog.inherited", { name: row.blueprintName }) : t("catalog.private")}
                  {page.platform ? ` · ${row.orgAlias}` : ""}
                </Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-wrap gap-2">
                <Chip size="sm">{t("status", { status: row.status })}</Chip>
                <Chip size="sm" variant="soft">{t("catalog.endpoints", { count: row.endpointCount })}</Chip>
                <Chip size="sm" variant="soft">{t("catalog.tools", { count: row.toolCount })}</Chip>
              </Card.Content>
            </Card>
          ))}
        </div>
      </section>
      <FormDialog state={importState} title={t("import.title")} description={t("import.description")} submitLabel={t("import.submit")} pending={pending} onSubmit={(close) => run(importIntegrationAction({ target, name, orgId, document: parseDocument(document), visibility: "internal" }), close)}>
        <TextField fullWidth value={name} onChange={setName}>
          <Label>{t("import.name")}</Label>
          <Input />
        </TextField>
        <Select selectedKey={target} onSelectionChange={(key) => setTarget(String(key))} aria-label={t("import.target")}>
          <Label>{t("import.target")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {page.platform ? <ListBox.Item id="blueprint" textValue={t("scope", { scope: "global" })}>{t("scope", { scope: "global" })}</ListBox.Item> : null}
              <ListBox.Item id="company" textValue={t("scope", { scope: "company" })}>{t("scope", { scope: "company" })}</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
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
        <TextField fullWidth value={document} onChange={setDocument}>
          <Label>{t("import.document")}</Label>
          <TextArea className="min-h-40" />
          <Description>{t("import.description")}</Description>
        </TextField>
      </FormDialog>
      <FormDialog state={draftState} title={t("draft.title")} submitLabel={t("draft.submit")} pending={pending} onSubmit={(close) => run(createCompanyDraftAction({ name, description: document, orgId }), close)}>
        <TextField fullWidth isRequired value={name} onChange={setName}>
          <Label>{t("draft.name")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={document} onChange={setDocument}>
          <Label>{t("draft.description")}</Label>
          <TextArea />
        </TextField>
      </FormDialog>
      <FormDialog state={visibilityState} title={t("visibilityForm.title", { name: visibilityId })} submitLabel={t("visibilityForm.submit")} pending={pending} onSubmit={(close) => run(setBlueprintVisibilityAction({ id: visibilityId, visibility, audience: audience.split("\n").map((item) => item.trim()).filter(Boolean) }), close)}>
        <Select selectedKey={visibility} onSelectionChange={(key) => setVisibility(String(key))} aria-label={t("catalog.visibilityAction")}>
          <Label>{t("catalog.visibilityAction")}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover>
            <ListBox>
              {["all", "selected", "internal", "disabled", "deprecated"].map((item) => (
                <ListBox.Item key={item} id={item} textValue={t("visibility", { visibility: item })}>{t("visibility", { visibility: item })}</ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField fullWidth value={audience} onChange={setAudience}>
          <Label>{t("visibilityForm.audience")}</Label>
          <TextArea />
        </TextField>
      </FormDialog>
    </div>
  );
}

function parseDocument(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}
