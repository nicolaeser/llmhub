"use client";

import type { Dispatch, SetStateAction } from "react";
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
  SearchField,
  Select,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { SearchX, Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { MAX_HOSTED_TOOLS, MCP_ACTIONS, MCP_STATIC_AUTH_TYPES, authNameValid, authUsesName } from "@/schemas/mcp";
import type { HostedTool, McpDocsSourceRef, McpDraft, McpDraftServer, McpToolAction } from "@/types/mcp";

const SEARCH_FROM = 8;

export type BuilderServer = {
  name: string;
  description: string;
  baseUrl: string;
  internal: boolean;
  authType: McpDraftServer["authType"];
  authHeader: string;
  secret: string;
  shared: boolean;
  loginFrom: number | null;
};

function methodColor(method: HostedTool["method"]): "success" | "warning" | "danger" {
  if (method === "GET") return "success";
  if (method === "DELETE") return "danger";
  return "warning";
}

export default function BuilderReview({
  draft,
  server,
  baseValid,
  tools,
  enabled,
  chosen,
  tooMany,
  search,
  pending,
  canDraft,
  onServer,
  onTools,
  onEnabled,
  onSearch,
  onRedraft,
}: {
  draft: McpDraft;
  server: BuilderServer;
  baseValid: boolean;
  tools: HostedTool[];
  enabled: string[];
  chosen: HostedTool[];
  tooMany: boolean;
  search: string;
  pending: boolean;
  canDraft: boolean;
  onServer: (patch: Partial<BuilderServer>) => void;
  onTools: Dispatch<SetStateAction<HostedTool[]>>;
  onEnabled: Dispatch<SetStateAction<string[]>>;
  onSearch: (search: string) => void;
  onRedraft: () => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? tools.filter((tool) => [tool.name, tool.title, tool.path].some((value) => value.toLowerCase().includes(needle)))
    : tools;
  const sourceName = (ref: McpDocsSourceRef) => t("builder.sourceName", { kind: ref.kind, name: ref.name });

  function patchTool(toolName: string, action: McpToolAction) {
    onTools((current) => current.map((tool) => (tool.name === toolName ? { ...tool, action } : tool)));
  }

  return (
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
      {draft.crawls.length || draft.parts > 1 ? (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("builder.crawlTitle")}</Alert.Title>
            {draft.crawls.map((crawl) => (
              <Alert.Description key={`${crawl.link}-${crawl.url}`} className="block break-words">
                {t("builder.crawlLine", { url: crawl.url, pages: crawl.pages, skipped: crawl.skipped, failed: crawl.failed })}
                {crawl.truncated ? ` ${t("builder.crawlLimit", { limit: crawl.truncated })}` : ""}
              </Alert.Description>
            ))}
            {draft.parts > 1 ? (
              <Alert.Description className="block">
                {t("builder.passes", { read: draft.passes >= draft.parts ? "all" : "some", passes: draft.passes, parts: draft.parts })}
              </Alert.Description>
            ) : null}
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
      <TextField fullWidth isRequired value={server.name} onChange={(name) => onServer({ name })} isDisabled={pending}>
        <Label>{t("form.name")}</Label>
        <Input />
        <Description>{t("form.nameHint")}</Description>
      </TextField>
      <TextField fullWidth value={server.description} onChange={(description) => onServer({ description })} isDisabled={pending}>
        <Label>{t("form.descriptionField")}</Label>
        <TextArea />
      </TextField>
      <TextField
        fullWidth
        isRequired
        value={server.baseUrl}
        onChange={(baseUrl) => onServer({ baseUrl })}
        isDisabled={pending}
        isInvalid={Boolean(server.baseUrl.trim()) && !baseValid}
      >
        <Label>{t("builder.baseUrl")}</Label>
        <Input inputMode="url" />
        {server.baseUrl.trim() && !baseValid ? (
          <FieldError>{t("builder.baseInvalid")}</FieldError>
        ) : (
          <Description>{t("builder.baseHint")}</Description>
        )}
      </TextField>
      <Switch isSelected={server.internal} onChange={(internal) => onServer({ internal })} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("form.internal")}</Label>
        </Switch.Content>
        <Description>{t("form.internalHint")}</Description>
      </Switch>
      <Switch isSelected={server.shared} onChange={(shared) => onServer({ shared })} isDisabled={pending}>
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
          selectedKey={server.authType}
          onSelectionChange={(key) => {
            const next = MCP_STATIC_AUTH_TYPES.find((item) => item === String(key));
            if (next) onServer({ authType: next, loginFrom: null });
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
              {MCP_STATIC_AUTH_TYPES.map((type) => (
                <ListBox.Item key={type} id={type} textValue={t("form.authOption", { type })}>
                  {t("form.authOption", { type })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          {server.loginFrom !== null ? (
            <Description>{t("builder.loginFromDocs", { index: server.loginFrom + 1 })}</Description>
          ) : null}
        </Select>
        {authUsesName(server.authType) ? (
          <TextField
            fullWidth
            isRequired
            value={server.authHeader}
            onChange={(authHeader) => onServer({ authHeader })}
            isDisabled={pending}
            isInvalid={server.authHeader.trim() !== "" && !authNameValid(server.authType, server.authHeader)}
          >
            <Label>{t("form.authName", { type: server.authType })}</Label>
            <Input autoComplete="off" spellCheck={false} placeholder={t("form.authNamePlaceholder", { type: server.authType })} />
          </TextField>
        ) : null}
      </div>
      {server.authType !== "none" && server.shared ? <p className="text-sm text-muted">{t("builder.companyKey")}</p> : null}
      {server.authType !== "none" && !server.shared ? (
        <TextField fullWidth isRequired value={server.secret} onChange={(secret) => onServer({ secret })} isDisabled={pending}>
          <Label>{t("form.secret", { type: server.authType })}</Label>
          <Input type="password" autoComplete="off" />
          <Description>{t("form.secretHint", { type: server.authType })}</Description>
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
          <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => onEnabled(tools.filter((tool) => tool.action === "read").map((tool) => tool.name))}>
            {t("builder.keepReads")}
          </Button>
          <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => onEnabled(tools.filter((tool) => tool.action !== "delete").map((tool) => tool.name))}>
            {t("builder.dropDeletes")}
          </Button>
          <Button size="sm" variant="tertiary" isDisabled={pending} onPress={() => onEnabled(tools.map((tool) => tool.name))}>
            {t("builder.includeAll")}
          </Button>
          <Button size="sm" variant="secondary" isDisabled={pending || !canDraft} onPress={onRedraft}>
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
        <SearchField value={search} onChange={onSearch} aria-label={t("builder.searchTools")} className="w-full">
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
                    onEnabled((current) =>
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
  );
}
