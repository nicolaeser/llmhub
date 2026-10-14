"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Label,
  ListBox,
  Select,
  Separator,
  Spinner,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { explainAccess } from "@/lib/mcp/resolve";
import { MCP_ACTIONS, MCP_MODES, MCP_SCOPES } from "@/schemas/mcp";
import type { HostedTool, McpAssignmentMode, McpAssignmentView, McpChain, McpTargetOption, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { loadMcpTargetsAction } from "../_action";

const EMPTY_OPTIONS: McpTargetOptions = { org: [], team: [], project: [], member: [], key: [] };

function chainFor(scope: AssignmentScope, option: McpTargetOption): McpChain {
  return {
    orgId: scope === "org" ? option.id : option.orgId,
    teamId: scope === "team" ? option.id : option.teamId,
    projectId: scope === "project" ? option.id : option.projectId,
    memberId: scope === "member" ? option.id : option.memberId,
    keyId: scope === "key" ? option.id : "",
  };
}

function ancestorsOf(rule: McpAssignmentView, options: McpTargetOptions): McpAssignmentView[] {
  const option = options[rule.scope].find((item) => item.id === rule.id);
  if (!option) return [];
  const chain = chainFor(rule.scope, option);
  const levels: [AssignmentScope, string][] = [
    ["org", chain.orgId],
    ["team", chain.teamId],
    ["project", chain.projectId],
    ["member", chain.memberId],
  ];
  return levels
    .filter(([scope, id]) => id && !(scope === rule.scope && id === rule.id))
    .map(([scope, id]) => ({ scope, id, label: "", mode: "allow", blockedTools: [], blockedActions: [] }));
}

export default function BuilderAccess({
  tools,
  global,
  rules,
  pending,
  onGlobal,
  onRules,
}: {
  tools: HostedTool[];
  global: boolean;
  rules: McpAssignmentView[];
  pending: boolean;
  onGlobal: (global: boolean) => void;
  onRules: (rules: McpAssignmentView[]) => void;
}) {
  const t = useTranslations("Mcp");
  const tAssign = useTranslations("Mcp.assign");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const [scope, setScope] = useState<AssignmentScope>("key");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<McpAssignmentMode>("allow");
  const [previewScope, setPreviewScope] = useState<AssignmentScope>("key");
  const [previewId, setPreviewId] = useState("");

  useEffect(() => {
    let active = true;
    loadMcpTargetsAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setOptions(EMPTY_OPTIONS);
        return;
      }
      setOptions(result.options);
    });
    return () => {
      active = false;
    };
  }, [showError]);

  const known = options ?? EMPTY_OPTIONS;
  const taken = new Set(rules.map((rule) => `${rule.scope}:${rule.id}`));
  const candidates = known[scope].filter((item) => !taken.has(`${scope}:${item.id}`));
  const toolItems = tools.map((tool) => ({
    id: tool.name,
    label: tool.title || tool.name,
    detail: t("builder.toolLine", { method: tool.method, path: tool.path }),
  }));
  const actionItems = MCP_ACTIONS.map((action) => ({ id: action, label: t("action", { action }) }));
  const reachable = global || rules.some((rule) => rule.mode === "allow");
  const previewOption = known[previewScope].find((item) => item.id === previewId) ?? null;
  const explanation = previewOption
    ? explainAccess(
        { global, toolsRestricted: false, allowedTools: [], tools },
        rules,
        chainFor(previewScope, previewOption),
      )
    : null;

  function labelOf(rule: Pick<McpAssignmentView, "scope" | "id">): string {
    return known[rule.scope].find((item) => item.id === rule.id)?.label || rule.id;
  }

  function sources(list: McpAssignmentView[]): string {
    return format.list(
      list.map((item) => tAssign("source", { scope: item.scope, label: labelOf(item) })),
      { type: "conjunction" },
    );
  }

  function inheritance(rule: McpAssignmentView): { granted: string; blocked: string } {
    const ancestors = ancestorsOf(rule, known).flatMap((ancestor) => {
      const match = rules.find((item) => item.scope === ancestor.scope && item.id === ancestor.id);
      return match ? [match] : [];
    });
    const grants = ancestors.filter((item) => item.mode === "allow");
    const blocks = ancestors.filter(
      (item) => item.mode === "block" && item.blockedTools.length === 0 && item.blockedActions.length === 0,
    );
    const granted = [grants.length ? sources(grants) : "", global ? tAssign("allCallers") : ""].filter(Boolean);
    return {
      granted: granted.length ? format.list(granted, { type: "conjunction" }) : "",
      blocked: blocks.length ? sources(blocks) : "",
    };
  }

  function addRule() {
    const option = known[scope].find((item) => item.id === target);
    if (!option) return;
    onRules([...rules, { scope, id: option.id, label: option.label, mode, blockedTools: [], blockedActions: [] }]);
    setPreviewScope(scope);
    setPreviewId(option.id);
    setTarget("");
  }

  function updateRule(index: number, change: Partial<McpAssignmentView>) {
    onRules(rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t("builder.accessHint")}</p>
      {reachable ? null : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("builder.noCaller")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <Switch isSelected={global} onChange={onGlobal} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{tAssign("global")}</Label>
        </Switch.Content>
        <Description>{tAssign("globalHint")}</Description>
      </Switch>
      <Separator />
      {options === null ? (
        <output aria-live="polite" aria-label={tCommon("loading")} className="flex justify-center py-6 text-accent">
          <Spinner color="current" />
        </output>
      ) : (
        <>
          <div className="grid items-end gap-3 sm:grid-cols-[10rem_1fr_auto_auto]">
            <Select
              fullWidth
              selectedKey={scope}
              onSelectionChange={(key) => {
                const next = MCP_SCOPES.find((item) => item === String(key));
                if (!next) return;
                setScope(next);
                setTarget("");
              }}
              isDisabled={pending}
            >
              <Label>{tAssign("scopeLabel")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {MCP_SCOPES.map((item) => (
                    <ListBox.Item key={item} id={item} textValue={tAssign("scope", { scope: item })}>
                      {tAssign("scope", { scope: item })}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <SearchSelect
              label={tAssign("target")}
              items={candidates}
              value={target}
              onChange={setTarget}
              isDisabled={pending}
            />
            <ToggleButtonGroup
              selectionMode="single"
              disallowEmptySelection
              aria-label={tAssign("modeLabel")}
              selectedKeys={[mode]}
              onSelectionChange={(keys) => {
                const next = MCP_MODES.find((item) => item === [...keys][0]);
                if (next) setMode(next);
              }}
              isDisabled={pending}
            >
              {MCP_MODES.map((item, index) => (
                <ToggleButton key={item} id={item}>
                  {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                  {tAssign("mode", { mode: item })}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Button variant="secondary" isDisabled={!target || pending} onPress={addRule}>
              <Plus size={14} aria-hidden />
              {tAssign("add")}
            </Button>
          </div>
          {rules.length === 0 ? <p className="text-sm text-muted">{tAssign("none")}</p> : null}
          {rules.map((rule, index) => {
            const inherited = inheritance(rule);
            return (
              <Card key={`${rule.scope}:${rule.id}`} variant="secondary">
              <Card.Content className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{labelOf(rule)}</span>
                      <Chip size="sm" variant="soft">
                        {tAssign("scope", { scope: rule.scope })}
                      </Chip>
                      <Chip size="sm" variant="soft" color={rule.mode === "allow" ? "success" : "danger"}>
                        {rule.mode === "block" && rule.blockedTools.length === 0 && rule.blockedActions.length === 0
                          ? tAssign("blockServer")
                          : tAssign("mode", { mode: rule.mode })}
                      </Chip>
                    </div>
                    {inherited.granted ? <p className="text-xs text-muted">{tAssign("inherited", { sources: inherited.granted })}</p> : null}
                    {inherited.blocked ? <p className="text-xs text-danger">{tAssign("blockedAbove", { sources: inherited.blocked })}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={pending}
                      onPress={() => updateRule(index, { mode: "allow", blockedTools: [], blockedActions: ["write", "delete"] })}
                    >
                      {t("builder.readsOnly")}
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={pending}
                      onPress={() => updateRule(index, { mode: "allow", blockedTools: [], blockedActions: [] })}
                    >
                      {t("builder.fullAccess")}
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="danger-soft"
                      aria-label={tAssign("remove", { label: labelOf(rule) })}
                      isDisabled={pending}
                      onPress={() => onRules(rules.filter((_, at) => at !== index))}
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </div>
                </div>
                <MultiPicker
                  label={tAssign("blockedTools")}
                  description={tAssign("blockedToolsHint", { mode: rule.mode })}
                  placeholder={tAssign("blockedToolsPlaceholder")}
                  searchLabel={tCommon("search")}
                  emptyLabel={tCommon("noResults")}
                  items={toolItems}
                  selected={rule.blockedTools.filter((id) => tools.some((tool) => tool.name === id))}
                  onChange={(ids) => updateRule(index, { blockedTools: ids })}
                  isDisabled={pending}
                />
                <MultiPicker
                  label={tAssign("blockedActions")}
                  description={tAssign("blockedActionsHint")}
                  placeholder={tAssign("blockedActionsPlaceholder")}
                  searchLabel={tCommon("search")}
                  emptyLabel={tCommon("noResults")}
                  items={actionItems}
                  selected={rule.blockedActions}
                  onChange={(ids) =>
                    updateRule(index, { blockedActions: MCP_ACTIONS.filter((action) => ids.includes(action)) })
                  }
                  isDisabled={pending}
                />
              </Card.Content>
              </Card>
            );
          })}
          <Separator />
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{tAssign("preview")}</p>
              <p className="text-sm text-muted">{tAssign("previewHint")}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Select
                fullWidth
                selectedKey={previewScope}
                onSelectionChange={(key) => {
                  const next = MCP_SCOPES.find((item) => item === String(key));
                  if (!next) return;
                  setPreviewScope(next);
                  setPreviewId("");
                }}
                isDisabled={pending}
              >
                <Label>{tAssign("scopeLabel")}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {MCP_SCOPES.map((item) => (
                      <ListBox.Item key={item} id={item} textValue={tAssign("scope", { scope: item })}>
                        {tAssign("scope", { scope: item })}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <SearchSelect
                label={tAssign("target")}
                items={known[previewScope]}
                value={previewId}
                onChange={setPreviewId}
                isDisabled={pending}
              />
            </div>
            {explanation ? (
              <Card variant="secondary">
                <Card.Content className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {tAssign("previewState", { state: explanation.state })}
                  </p>
                  <p className="text-sm text-muted">
                    {tAssign("previewTools", {
                      count: explanation.tools.length,
                      list: format.list(explanation.tools, { type: "conjunction" }),
                    })}
                  </p>
                  {explanation.blockedActions.length ? (
                    <p className="text-sm text-muted">
                      {tAssign("previewActions", {
                        list: format.list(
                          explanation.blockedActions.map((action) => t("action", { action })),
                          { type: "conjunction" },
                        ),
                      })}
                    </p>
                  ) : null}
                </Card.Content>
              </Card>
            ) : (
              <p className="text-sm text-muted">{t("builder.previewEmpty")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
