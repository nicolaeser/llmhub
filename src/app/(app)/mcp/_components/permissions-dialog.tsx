"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Dropdown,
  Input,
  Label,
  SearchField,
  Separator,
  Switch,
  Table,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Ban, Check, ChevronDown, CircleCheck, Minus, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { classifyTools, isToolAction, roleAllowsTool, toolGrant } from "@/lib/mcp/resolve";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpRoleView, McpServerView, McpToolActions, McpToolGrant, McpToolSpec } from "@/types/mcp";
import { ensureMcpRolesAction, saveMcpPermissionsAction } from "../_action";

const TABS = ["roles", "tools"] as const;
const GRANTS = ["inherit", "allow", "deny"] as const satisfies readonly McpToolGrant[];
const NEXT_GRANT = { inherit: "allow", allow: "deny", deny: "inherit" } as const satisfies Record<McpToolGrant, McpToolGrant>;
const NEW_ROLE = "new:";
const UNCLASSIFIED = "none";

function draftOf(role: McpRoleView): McpRoleView {
  return { ...role, actions: [...role.actions], tools: [...role.tools], deniedTools: [...role.deniedTools] };
}

function matches(tool: McpToolSpec, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return tool.name.toLowerCase().includes(needle) || tool.title.toLowerCase().includes(needle);
}

export default function PermissionsDialog({
  state,
  server,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  server: McpServerView | null;
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [tab, setTab] = useState<(typeof TABS)[number]>("roles");
  const [edits, setEdits] = useState<Record<string, McpRoleView>>({});
  const [added, setAdded] = useState<McpRoleView[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [overrides, setOverrides] = useState<McpToolActions | null>(null);
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const [, startEnsure] = useTransition();
  const ensured = useRef("");
  const created = useRef(0);

  const builtinCount = (server?.roles ?? []).filter((role) => role.builtin).length;
  useEffect(() => {
    if (!state.isOpen || !server || builtinCount >= 3 || ensured.current === server.id) return;
    ensured.current = server.id;
    const report = onSaved;
    startEnsure(async () => {
      const result = await ensureMcpRolesAction(server.id);
      if (isActionFail(result)) {
        ensured.current = "";
        showError(result.error);
        return;
      }
      report(result.server);
    });
  }, [builtinCount, onSaved, server, showError, startEnsure, state.isOpen]);

  const toolActions = overrides ?? server?.toolActions ?? {};
  const baseTools = server?.tools ?? [];
  const tools = classifyTools(baseTools, toolActions);
  const visible = tools.filter((tool) => matches(tool, query));
  const roles: McpRoleView[] = [
    ...(server?.roles ?? []).filter((role) => !removed.includes(role.id)).map((role) => edits[role.id] ?? draftOf(role)),
    ...added,
  ];
  const current = roles.find((role) => role.id === selected) ?? roles[0] ?? null;
  const suggested = baseTools.filter((tool) => tool.hint && !toolActions[tool.name] && !tool.action);
  const namesMissing = roles.some((role) => !role.name.trim());

  function roleLabel(role: McpRoleView): string {
    return role.builtin ? t("assign.rolePreset", { role: role.key }) : role.name || t("permissions.untitled");
  }

  function patch(role: McpRoleView, change: Partial<McpRoleView>) {
    const next = { ...role, ...change };
    if (role.id.startsWith(NEW_ROLE)) {
      setAdded((list) => list.map((item) => (item.id === role.id ? next : item)));
      return;
    }
    setEdits((all) => ({ ...all, [role.id]: next }));
  }

  function setGrant(role: McpRoleView, name: string, grant: McpToolGrant) {
    patch(role, {
      tools: grant === "allow" ? [...role.tools.filter((item) => item !== name), name] : role.tools.filter((item) => item !== name),
      deniedTools:
        grant === "deny"
          ? [...role.deniedTools.filter((item) => item !== name), name]
          : role.deniedTools.filter((item) => item !== name),
    });
  }

  function addRole() {
    created.current += 1;
    const id = `${NEW_ROLE}${created.current}`;
    setAdded((list) => [
      ...list,
      {
        id,
        key: "",
        name: t("permissions.untitled"),
        description: "",
        allActions: false,
        actions: ["read"],
        tools: [],
        deniedTools: [],
        builtin: false,
        assigned: 0,
      },
    ]);
    setSelected(id);
    setTab("roles");
  }

  function removeRole(role: McpRoleView) {
    if (role.builtin || role.assigned > 0) return;
    if (role.id.startsWith(NEW_ROLE)) setAdded((list) => list.filter((item) => item.id !== role.id));
    else setRemoved((list) => [...list, role.id]);
    setSelected("");
  }

  function classify(tool: McpToolSpec, value: string) {
    const next = { ...toolActions };
    if (isToolAction(value) && value !== tool.action) next[tool.name] = value;
    else delete next[tool.name];
    setOverrides(next);
  }

  function acceptHints() {
    const next = { ...toolActions };
    for (const tool of suggested) if (tool.hint) next[tool.name] = tool.hint;
    setOverrides(next);
  }

  function save(close: () => void) {
    if (!server) return;
    start(async () => {
      const result = await saveMcpPermissionsAction({
        serverId: server.id,
        toolActions,
        roles: roles.map((role) => ({
          id: role.id.startsWith(NEW_ROLE) ? "" : role.id,
          name: role.name,
          description: role.description,
          allActions: role.allActions,
          actions: role.actions,
          tools: role.tools,
          deniedTools: role.deniedTools,
        })),
        removed,
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("permissions.saved"), { variant: "success" });
      close();
    });
  }

  function actionMenu(tool: McpToolSpec) {
    const base = baseTools.find((item) => item.name === tool.name) ?? tool;
    const options = base.action ? [...MCP_ACTIONS] : [UNCLASSIFIED, ...MCP_ACTIONS];
    const value = tool.action ?? UNCLASSIFIED;
    return (
      <div className="space-y-1">
        <Dropdown>
          <Button size="sm" variant="tertiary" aria-label={t("permissions.classify", { tool: tool.name })}>
            {tool.action ? t("action", { action: tool.action }) : t("permissions.unclassified")}
            <ChevronDown size={14} aria-hidden />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label={t("permissions.classify", { tool: tool.name })}
              selectionMode="single"
              selectedKeys={[value]}
              onAction={(key) => classify(base, String(key))}
            >
              {options.map((option) => {
                const label = isToolAction(option) ? t("action", { action: option }) : t("permissions.unclassified");
                return (
                  <Dropdown.Item key={option} id={option} textValue={label}>
                    {label}
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                );
              })}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {base.hint && base.hint !== tool.action ? (
          <p className="text-xs text-muted">{t("permissions.serverHint", { action: base.hint })}</p>
        ) : null}
      </div>
    );
  }

  function grantButton(role: McpRoleView, tool: McpToolSpec, labeled: boolean) {
    const grant = toolGrant(role, tool.name);
    const granted = roleAllowsTool(role, tool);
    const icon =
      grant === "deny" ? (
        <Ban size={16} className="text-danger" aria-hidden />
      ) : grant === "allow" ? (
        <CircleCheck size={16} className="text-success" aria-hidden />
      ) : granted ? (
        <Check size={16} className="text-foreground" aria-hidden />
      ) : (
        <Minus size={16} className="text-muted" aria-hidden />
      );
    return (
      <Button
        key={role.id}
        isIconOnly={!labeled}
        size="sm"
        variant={labeled ? "secondary" : "ghost"}
        isDisabled={pending}
        aria-label={t("permissions.cell", { role: roleLabel(role), tool: tool.name, grant, granted: String(granted) })}
        onPress={() => setGrant(role, tool.name, NEXT_GRANT[grant])}
      >
        {icon}
        {labeled ? roleLabel(role) : null}
      </Button>
    );
  }

  const search =
    tools.length > 6 ? (
      <SearchField value={query} onChange={setQuery} aria-label={t("permissions.search")} className="w-full sm:max-w-xs">
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder={t("permissions.search")} />
          <SearchField.ClearButton aria-label={tCommon("close")} />
        </SearchField.Group>
      </SearchField>
    ) : null;

  const empty = tools.length ? (
    visible.length ? null : <p className="text-sm text-muted">{t("permissions.noMatches")}</p>
  ) : (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{t("permissions.noTools")}</Alert.Description>
      </Alert.Content>
    </Alert>
  );

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("permissions.title", { name: server?.name ?? "" })}
      description={t("permissions.description")}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!server || namesMissing}
      onSubmit={save}
    >
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          const next = TABS.find((item) => item === String(key));
          if (next) setTab(next);
        }}
        aria-label={t("permissions.tabsLabel")}
      >
        <Tabs.List className="w-full flex-wrap" aria-label={t("permissions.tabsLabel")}>
          {TABS.map((id) => (
            <Tabs.Tab key={id} id={id} className="w-auto whitespace-nowrap">
              {t("permissions.tabs", { tab: id })}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel id="roles" className="space-y-5 pt-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("permissions.rolesLabel")}>
            {roles.map((role) => (
              <Button
                key={role.id}
                size="sm"
                variant={current?.id === role.id ? "primary" : "tertiary"}
                onPress={() => setSelected(role.id)}
              >
                {roleLabel(role)}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onPress={addRole} isDisabled={pending}>
              <Plus size={14} aria-hidden />
              {t("permissions.newRole")}
            </Button>
          </div>

          {current ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  fullWidth
                  isRequired
                  value={current.builtin ? roleLabel(current) : current.name}
                  onChange={(name) => patch(current, { name })}
                  isDisabled={current.builtin || pending}
                >
                  <Label>{t("permissions.name")}</Label>
                  <Input />
                  <Description>
                    {current.builtin ? t("permissions.builtinHint") : t("permissions.assigned", { count: current.assigned })}
                  </Description>
                </TextField>
                <TextField
                  fullWidth
                  value={current.description}
                  onChange={(description) => patch(current, { description })}
                  isDisabled={pending}
                >
                  <Label>{t("permissions.roleDescription")}</Label>
                  <Input />
                </TextField>
              </div>

              <Card variant="secondary">
                <Card.Header>
                  <Card.Title>{t("permissions.baseline")}</Card.Title>
                  <Card.Description>{t("permissions.baselineHint")}</Card.Description>
                </Card.Header>
                <Card.Content className="gap-4">
                  <ToggleButtonGroup
                    selectionMode="multiple"
                    aria-label={t("permissions.actions")}
                    selectedKeys={current.allActions ? [...MCP_ACTIONS] : current.actions}
                    onSelectionChange={(keys) => patch(current, { actions: MCP_ACTIONS.filter((action) => keys.has(action)) })}
                    isDisabled={pending || current.allActions}
                  >
                    {MCP_ACTIONS.map((action, index) => (
                      <ToggleButton key={action} id={action}>
                        {index > 0 ? <ToggleButtonGroup.Separator /> : null}
                        {t("action", { action })}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  <Switch
                    isSelected={current.allActions}
                    onChange={(allActions) => patch(current, { allActions })}
                    isDisabled={pending}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>{t("permissions.allActions")}</Label>
                    </Switch.Content>
                    <Description>{t("permissions.allActionsHint")}</Description>
                  </Switch>
                </Card.Content>
              </Card>

              <div className="space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      {t("permissions.perTool")}
                      <Chip size="sm" variant="soft">
                        {t("permissions.grantedCount", {
                          granted: tools.filter((tool) => roleAllowsTool(current, tool)).length,
                          count: tools.length,
                        })}
                      </Chip>
                    </p>
                    <p className="text-sm text-muted">{t("permissions.perToolHint")}</p>
                  </div>
                  {current.tools.length || current.deniedTools.length ? (
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() => patch(current, { tools: [], deniedTools: [] })}
                      isDisabled={pending}
                    >
                      <RotateCcw size={14} aria-hidden />
                      {t("permissions.resetTools")}
                    </Button>
                  ) : null}
                </div>
                {search}
                {empty}
                {visible.length ? (
                  <Card variant="secondary">
                    <Card.Content className="gap-0">
                      {visible.map((tool, index) => {
                        const grant = toolGrant(current, tool.name);
                        const granted = roleAllowsTool(current, tool);
                        return (
                          <div key={tool.name}>
                            {index > 0 ? <Separator /> : null}
                            <div className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                              <div className="min-w-0 space-y-1 md:flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium break-all text-foreground">{tool.title || tool.name}</span>
                                  <Chip size="sm" variant="soft" color={tool.action ? "default" : "warning"}>
                                    {tool.action ? t("action", { action: tool.action }) : t("permissions.unclassified")}
                                  </Chip>
                                  <Chip size="sm" variant="soft" color={granted ? "success" : "default"}>
                                    {t("permissions.effect", { granted: String(granted) })}
                                  </Chip>
                                </div>
                                {tool.title ? <p className="font-mono text-xs break-all text-muted">{tool.name}</p> : null}
                              </div>
                              <ToggleButtonGroup
                                size="sm"
                                selectionMode="single"
                                disallowEmptySelection
                                aria-label={t("permissions.grantLabel", { tool: tool.name })}
                                selectedKeys={[grant]}
                                onSelectionChange={(keys) => {
                                  const next = GRANTS.find((item) => item === [...keys][0]);
                                  if (next) setGrant(current, tool.name, next);
                                }}
                                isDisabled={pending}
                              >
                                {GRANTS.map((item, position) => (
                                  <ToggleButton key={item} id={item}>
                                    {position > 0 ? <ToggleButtonGroup.Separator /> : null}
                                    {t("permissions.grant", { grant: item })}
                                  </ToggleButton>
                                ))}
                              </ToggleButtonGroup>
                            </div>
                          </div>
                        );
                      })}
                    </Card.Content>
                  </Card>
                ) : null}
              </div>

              {current.builtin ? null : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="danger-soft"
                    onPress={() => removeRole(current)}
                    isDisabled={pending || current.assigned > 0}
                  >
                    <Trash2 size={14} aria-hidden />
                    {t("permissions.delete")}
                  </Button>
                  {current.assigned > 0 ? <p className="text-sm text-muted">{t("permissions.deleteBlocked")}</p> : null}
                </div>
              )}
            </>
          ) : null}
        </Tabs.Panel>

        <Tabs.Panel id="tools" className="space-y-4 pt-4">
          <p className="text-sm text-muted">{t("permissions.toolsHint")}</p>
          {suggested.length ? (
            <Alert status="accent">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{t("permissions.suggestions", { count: suggested.length })}</Alert.Description>
              </Alert.Content>
              <Button size="sm" variant="secondary" onPress={acceptHints} isDisabled={pending}>
                <Sparkles size={14} aria-hidden />
                {t("permissions.applySuggestions")}
              </Button>
            </Alert>
          ) : null}
          {search}
          {empty}
          {visible.length ? (
            <>
              <RowCards label={t("permissions.matrixLabel")}>
                {visible.map((tool) => (
                  <RowCard
                    key={tool.name}
                    variant="secondary"
                    title={<span className="break-all">{tool.title || tool.name}</span>}
                    description={
                      tool.title ? <span className="font-mono text-xs break-all">{tool.name}</span> : undefined
                    }
                    details={[{ label: t("permissions.columnAction"), value: actionMenu(tool), wide: true }]}
                    actions={roles.map((role) => grantButton(role, tool, true))}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("permissions.matrixLabel")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content className="min-w-xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("permissions.columnTool")}</Table.Column>
                      <Table.Column>{t("permissions.columnAction")}</Table.Column>
                      {roles.map((role) => (
                        <Table.Column key={role.id} id={role.id}>
                          {roleLabel(role)}
                        </Table.Column>
                      ))}
                    </Table.Header>
                    <Table.Body>
                      {visible.map((tool) => (
                        <Table.Row key={tool.name} id={tool.name}>
                          <Table.Cell>
                            <div className="min-w-0">
                              <p className="text-sm font-medium break-all">{tool.title || tool.name}</p>
                              {tool.title ? <p className="font-mono text-xs break-all text-muted">{tool.name}</p> : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>{actionMenu(tool)}</Table.Cell>
                          {roles.map((role) => (
                            <Table.Cell key={role.id}>{grantButton(role, tool, false)}</Table.Cell>
                          ))}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          ) : null}
          {visible.length ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Check size={14} className="text-foreground" aria-hidden />
                {t("permissions.legend", { kind: "inherited" })}
              </span>
              <span className="flex items-center gap-1">
                <CircleCheck size={14} className="text-success" aria-hidden />
                {t("permissions.legend", { kind: "allowed" })}
              </span>
              <span className="flex items-center gap-1">
                <Ban size={14} className="text-danger" aria-hidden />
                {t("permissions.legend", { kind: "denied" })}
              </span>
              <span className="flex items-center gap-1">
                <Minus size={14} className="text-muted" aria-hidden />
                {t("permissions.legend", { kind: "none" })}
              </span>
            </div>
          ) : null}
        </Tabs.Panel>
      </Tabs>
    </FormDialog>
  );
}
