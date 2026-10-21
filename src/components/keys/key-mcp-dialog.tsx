"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  Disclosure,
  Label,
  ListBox,
  SearchField,
  Select,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Blocks, SearchX } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import FormDialog from "@/components/console/form-dialog";
import { SectionLoading } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { explainAccess } from "@/lib/mcp/resolve";
import { MCP_ACTIONS, MCP_KEY_ACCESS_MODES, MCP_ROLE_KEYS } from "@/schemas/mcp";
import type { ActionFail } from "@/types/actions";
import type {
  McpAssignmentView,
  McpExplanation,
  McpKeyAccess,
  McpKeyAccessChoice,
  McpKeyServerAccess,
  McpRoleView,
  McpToolAction,
  McpToolSpec,
} from "@/types/mcp";

const SEARCH_FROM = 6;

type ToolState = "on" | "hiddenHere" | "actionHere" | "hiddenAbove" | "role" | "server" | "none";
type ServerStatus = "paused" | "blocked" | "none" | "unconnected" | "available";

function choiceOf(server: McpKeyServerAccess): McpKeyAccessChoice {
  const rule = server.rule;
  const blockedActions = MCP_ACTIONS.filter((action) => rule?.blockedActions.includes(action));
  if (!rule) return { serverId: server.serverId, mode: "inherit", roleId: "", blockedTools: [], blockedActions: [] };
  if (rule.mode === "allow") {
    return { serverId: server.serverId, mode: "allow", roleId: rule.roleId, blockedTools: rule.blockedTools, blockedActions };
  }
  if (!rule.blockedTools.length && !blockedActions.length) {
    return { serverId: server.serverId, mode: "block", roleId: "", blockedTools: [], blockedActions: [] };
  }
  return { serverId: server.serverId, mode: "inherit", roleId: "", blockedTools: rule.blockedTools, blockedActions };
}

function sameChoice(a: McpKeyAccessChoice, b: McpKeyAccessChoice): boolean {
  const narrows = a.mode !== "block";
  return (
    a.mode === b.mode &&
    (a.mode !== "allow" || a.roleId === b.roleId) &&
    (!narrows || ([...a.blockedTools].sort().join() === [...b.blockedTools].sort().join() && a.blockedActions.join() === b.blockedActions.join()))
  );
}

function roleGrant(role: McpRoleView | undefined): McpAssignmentView["role"] {
  if (!role) return null;
  return {
    key: role.key,
    name: role.name,
    allActions: role.allActions,
    actions: role.actions,
    tools: role.tools,
    deniedTools: role.deniedTools,
  };
}

function keyRule(access: McpKeyAccess, server: McpKeyServerAccess, choice: McpKeyAccessChoice): McpAssignmentView | null {
  if (choice.mode === "inherit" && !choice.blockedTools.length && !choice.blockedActions.length) return null;
  const role = choice.mode === "allow" ? server.roles.find((item) => item.id === choice.roleId) : undefined;
  return {
    scope: "key",
    id: access.keyId,
    label: access.label,
    mode: choice.mode === "allow" ? "allow" : "block",
    blockedTools: choice.mode === "block" ? [] : choice.blockedTools,
    blockedActions: choice.mode === "block" ? [] : choice.blockedActions,
    roleId: role?.id ?? "",
    role: roleGrant(role),
  };
}

function explain(access: McpKeyAccess, server: McpKeyServerAccess, choice: McpKeyAccessChoice | null): McpExplanation {
  const own = choice ? keyRule(access, server, choice) : null;
  return explainAccess(server, own ? [...server.inherited, own] : server.inherited, access.chain);
}

function statusOf(server: McpKeyServerAccess, explanation: McpExplanation): ServerStatus {
  if (!server.enabled) return "paused";
  if (explanation.state === "blocked") return "blocked";
  if (explanation.state === "none") return "none";
  if (!server.connected) return "unconnected";
  return "available";
}

function statusColor(status: ServerStatus): "success" | "warning" | "danger" | "default" {
  if (status === "available") return "success";
  if (status === "unconnected") return "warning";
  if (status === "blocked") return "danger";
  return "default";
}

function actionColor(action: McpToolAction | undefined): "success" | "warning" | "danger" | "default" {
  if (action === "read") return "success";
  if (action === "write") return "warning";
  if (action === "delete") return "danger";
  return "default";
}

function toolState(
  tool: McpToolSpec,
  server: McpKeyServerAccess,
  choice: McpKeyAccessChoice,
  explanation: McpExplanation,
): ToolState {
  if (explanation.state !== "granted") return "none";
  if (explanation.tools.includes(tool.name)) return "on";
  if (choice.blockedTools.includes(tool.name)) return "hiddenHere";
  if (tool.action && choice.blockedActions.includes(tool.action)) return "actionHere";
  const above = server.inherited;
  if (above.some((rule) => rule.blockedTools.includes(tool.name) || (tool.action && rule.blockedActions.includes(tool.action)))) {
    return "hiddenAbove";
  }
  if (server.toolsRestricted && !server.allowedTools.includes(tool.name)) return "server";
  return "role";
}

export default function KeyMcpDialog({
  state,
  keyId,
  keyName,
  onLoad,
  onSave,
}: {
  state: ReturnType<typeof useOverlayState>;
  keyId: string | null;
  keyName: string;
  onLoad: (keyId: string) => Promise<McpKeyAccess | ActionFail>;
  onSave: (input: { keyId: string; servers: McpKeyAccessChoice[] }) => Promise<McpKeyAccess | ActionFail>;
}) {
  const t = useTranslations("Keys.mcp");
  const tMcp = useTranslations("Mcp");
  const tAssign = useTranslations("Mcp.assign");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const [access, setAccess] = useState<McpKeyAccess | null>(null);
  const [choices, setChoices] = useState<Record<string, McpKeyAccessChoice>>({});
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, startSave] = useTransition();

  useEffect(() => {
    if (!keyId) return;
    let active = true;
    onLoad(keyId).then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setFailed(true);
        return;
      }
      setAccess(result);
      setChoices(Object.fromEntries(result.servers.map((server) => [server.serverId, choiceOf(server)])));
    });
    return () => {
      active = false;
    };
  }, [keyId, onLoad, showError]);

  const servers = access?.servers ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? servers.filter((server) => [server.name, server.description].some((value) => value.toLowerCase().includes(needle)))
    : servers;
  const changed = access
    ? access.servers.filter((server) => choices[server.serverId] && !sameChoice(choices[server.serverId]!, choiceOf(server)))
    : [];
  const totals = access
    ? access.servers.reduce(
        (sum, server) => {
          const explanation = explain(access, server, choices[server.serverId] ?? null);
          if (statusOf(server, explanation) !== "available") return sum;
          return { servers: sum.servers + 1, tools: sum.tools + explanation.tools.length };
        },
        { servers: 0, tools: 0 },
      )
    : { servers: 0, tools: 0 };

  function update(serverId: string, change: Partial<McpKeyAccessChoice>) {
    setChoices((current) => {
      const previous = current[serverId];
      if (!previous) return current;
      return { ...current, [serverId]: { ...previous, ...change } };
    });
  }

  function sources(list: McpAssignmentView[]): string {
    return format.list(
      list.map((rule) => tAssign("source", { scope: rule.scope, label: rule.label })),
      { type: "conjunction" },
    );
  }

  function inheritedLine(server: McpKeyServerAccess): string {
    if (!access) return "";
    const base = explain(access, server, null);
    if (base.state === "blocked") return t("inheritedBlocked", { sources: sources(base.blockedBy) });
    if (base.grantedBy.length) {
      const role = base.grantedBy.find((rule) => rule.role)?.role;
      return t("inheritedBy", {
        sources: sources(base.grantedBy),
        hasRole: role ? "yes" : "no",
        role: role ? roleLabel(role.key, role.name) : "",
      });
    }
    if (base.global) return t("inheritedAll");
    return t("inheritedNone");
  }

  function roleLabel(key: string, name: string): string {
    return (MCP_ROLE_KEYS as readonly string[]).includes(key) ? tAssign("rolePreset", { role: key }) : name;
  }

  function save(close: () => void) {
    if (!access || !changed.length) return;
    startSave(async () => {
      const result = await onSave({
        keyId: access.keyId,
        servers: changed.map((server) => choices[server.serverId]!),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setAccess(result);
      setChoices(Object.fromEntries(result.servers.map((server) => [server.serverId, choiceOf(server)])));
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="2xl"
      title={t("title", { name: keyName })}
      description={t("description")}
      submitLabel={t("save", { count: changed.length })}
      pending={saving}
      isSubmitDisabled={!access || !changed.length}
      onSubmit={save}
    >
      {!access ? (
        failed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("loadFailed")}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <SectionLoading rows={4} />
        )
      ) : servers.length === 0 ? (
        <EmptyState icon={Blocks} title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color={totals.servers ? "success" : "default"}>
              {t("summaryServers", { count: totals.servers, total: servers.length })}
            </Chip>
            <Chip size="sm" variant="soft">
              {t("summaryTools", { count: totals.tools })}
            </Chip>
            {changed.length ? (
              <Chip size="sm" variant="soft" color="accent">
                {t("unsaved", { count: changed.length })}
              </Chip>
            ) : null}
          </div>
          {servers.length >= SEARCH_FROM ? (
            <SearchField value={search} onChange={setSearch} aria-label={t("search")} className="w-full">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
          ) : null}
          {shown.length === 0 ? <EmptyState icon={SearchX} title={t("noMatch")} /> : null}
          {shown.map((server) => {
            const choice = choices[server.serverId] ?? choiceOf(server);
            const explanation = explain(access, server, choice);
            const status = statusOf(server, explanation);
            const allowed = MCP_ACTIONS.filter((action) => !choice.blockedActions.includes(action));
            return (
              <Card key={server.serverId} variant="secondary">
                <Card.Content>
                  <Disclosure>
                    <Disclosure.Heading>
                      <Disclosure.Trigger className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-medium break-all text-foreground">{server.name}</span>
                          {server.kind === "hosted" ? (
                            <Chip size="sm" variant="soft">
                              {tMcp("hosted")}
                            </Chip>
                          ) : null}
                          {sameChoice(choice, choiceOf(server)) ? null : (
                            <Chip size="sm" variant="soft" color="accent">
                              {t("changed")}
                            </Chip>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          <Chip size="sm" variant="soft" color={statusColor(status)}>
                            {status === "available"
                              ? t("toolCount", { count: explanation.tools.length, total: server.tools.length })
                              : t("status", { status })}
                          </Chip>
                          <Disclosure.Indicator />
                        </span>
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="flex flex-col gap-4 pt-4">
                        {server.description ? <p className="text-sm text-muted">{server.description}</p> : null}
                        <p className="text-sm text-muted">{inheritedLine(server)}</p>
                        {status === "unconnected" ? (
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description>{t("unconnected")}</Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
                        <div className="flex flex-col items-start gap-2">
                          <Label>{t("modeLabel")}</Label>
                          <ToggleButtonGroup
                            size="sm"
                            selectionMode="single"
                            disallowEmptySelection
                            aria-label={t("modeLabel")}
                            selectedKeys={[choice.mode]}
                            onSelectionChange={(keys) => {
                              const next = MCP_KEY_ACCESS_MODES.find((item) => item === [...keys][0]);
                              if (next) update(server.serverId, { mode: next, roleId: next === "allow" ? choice.roleId : "" });
                            }}
                            isDisabled={saving}
                          >
                            {MCP_KEY_ACCESS_MODES.map((mode, index) => (
                              <ToggleButton key={mode} id={mode}>
                                {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                                {t("mode", { mode })}
                              </ToggleButton>
                            ))}
                          </ToggleButtonGroup>
                          <Description>{t("modeHint", { mode: choice.mode })}</Description>
                        </div>
                        {choice.mode === "block" ? null : (
                          <>
                            <div className="grid gap-4 md:grid-cols-2">
                              {choice.mode === "allow" ? (
                                <Select
                                  fullWidth
                                  selectedKey={choice.roleId || "every"}
                                  onSelectionChange={(key) => update(server.serverId, { roleId: String(key) === "every" ? "" : String(key) })}
                                  isDisabled={saving}
                                >
                                  <Label>{t("role")}</Label>
                                  <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                  </Select.Trigger>
                                  <Select.Popover>
                                    <ListBox>
                                      <ListBox.Item id="every" textValue={tAssign("roleNone")}>
                                        {tAssign("roleNone")}
                                        <ListBox.ItemIndicator />
                                      </ListBox.Item>
                                      {server.roles.map((role) => (
                                        <ListBox.Item key={role.id} id={role.id} textValue={roleLabel(role.key, role.name)}>
                                          {roleLabel(role.key, role.name)}
                                          <ListBox.ItemIndicator />
                                        </ListBox.Item>
                                      ))}
                                    </ListBox>
                                  </Select.Popover>
                                  <Description>{t("roleHint")}</Description>
                                </Select>
                              ) : null}
                              <CheckboxGroup
                                value={allowed}
                                onChange={(values) =>
                                  update(server.serverId, {
                                    blockedActions: MCP_ACTIONS.filter((action) => !values.includes(action)),
                                  })
                                }
                                isDisabled={saving}
                              >
                                <Label>{t("actions")}</Label>
                                <div className="flex flex-wrap gap-4">
                                  {MCP_ACTIONS.map((action) => (
                                    <Checkbox key={action} value={action}>
                                      <Checkbox.Content>
                                        <Checkbox.Control>
                                          <Checkbox.Indicator />
                                        </Checkbox.Control>
                                        <Label>{tMcp("action", { action })}</Label>
                                      </Checkbox.Content>
                                    </Checkbox>
                                  ))}
                                </div>
                                <Description>{t("actionsHint")}</Description>
                              </CheckboxGroup>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-foreground">{t("tools")}</p>
                                <p className="text-sm text-muted">{t("toolsHint")}</p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="tertiary"
                                  isDisabled={saving}
                                  onPress={() => update(server.serverId, { blockedTools: [], blockedActions: ["write", "delete"] })}
                                >
                                  {t("readOnly")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="tertiary"
                                  isDisabled={saving}
                                  onPress={() => update(server.serverId, { blockedTools: [], blockedActions: [] })}
                                >
                                  {t("showAll")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="tertiary"
                                  isDisabled={saving}
                                  onPress={() => update(server.serverId, { blockedTools: server.tools.map((tool) => tool.name) })}
                                >
                                  {t("hideAll")}
                                </Button>
                              </div>
                            </div>
                            {server.tools.length === 0 ? <p className="text-sm text-muted">{t("noTools")}</p> : null}
                            <ul className="flex flex-col divide-y divide-border">
                              {server.tools.map((tool) => {
                                const visible = !choice.blockedTools.includes(tool.name);
                                const current = toolState(tool, server, choice, explanation);
                                return (
                                  <li key={tool.name} className="flex flex-wrap items-center justify-between gap-3 py-2">
                                    <div className="min-w-0 flex-1 space-y-0.5">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-medium break-all text-foreground">{tool.title || tool.name}</span>
                                        {tool.action ? (
                                          <Chip size="sm" variant="soft" color={actionColor(tool.action)}>
                                            {tMcp("action", { action: tool.action })}
                                          </Chip>
                                        ) : null}
                                      </div>
                                      <p className="font-mono text-xs break-all text-muted">{tool.name}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      <span className={current === "on" ? "text-xs text-success" : "text-xs text-muted"}>
                                        {t("toolState", { state: current })}
                                      </span>
                                      <Switch
                                        size="sm"
                                        isSelected={visible}
                                        isDisabled={saving}
                                        aria-label={t("toolVisible", { name: tool.title || tool.name })}
                                        onChange={(next) =>
                                          update(server.serverId, {
                                            blockedTools: next
                                              ? choice.blockedTools.filter((name) => name !== tool.name)
                                              : [...choice.blockedTools, tool.name],
                                          })
                                        }
                                      >
                                        <Switch.Content>
                                          <Switch.Control>
                                            <Switch.Thumb />
                                          </Switch.Control>
                                        </Switch.Content>
                                      </Switch>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        )}
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </Card.Content>
              </Card>
            );
          })}
        </>
      )}
    </FormDialog>
  );
}
