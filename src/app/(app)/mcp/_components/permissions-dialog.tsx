"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Tabs, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { SectionLoading } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { classifyTools, isToolAction } from "@/lib/mcp/resolve";
import type { McpRoleView, McpServerView, McpToolActions, McpToolGrant, McpToolSpec } from "@/types/mcp";
import { ensureMcpRolesAction, saveMcpPermissionsAction } from "../_action";
import RoleEditor from "./role-editor";
import RoleList from "./role-list";
import { draftOf, NEW_ROLE, withGrant } from "./role-view";
import ToolActionsTab from "./tool-actions-tab";

const TABS = ["roles", "tools"] as const;

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
  const [editing, setEditing] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<McpToolActions | null>(null);
  const [pending, start] = useTransition();
  const [ensuring, startEnsure] = useTransition();
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
  const roles: McpRoleView[] = [
    ...(server?.roles ?? []).filter((role) => !removed.includes(role.id)).map((role) => edits[role.id] ?? draftOf(role)),
    ...added,
  ];
  const current = roles.find((role) => role.id === editing) ?? null;
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

  function grant(role: McpRoleView, name: string, value: McpToolGrant) {
    patch(role, withGrant(role, name, value));
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
    setEditing(id);
    setTab("roles");
  }

  function removeRole(role: McpRoleView) {
    if (role.builtin || role.assigned > 0) return;
    if (role.id.startsWith(NEW_ROLE)) setAdded((list) => list.filter((item) => item.id !== role.id));
    else setRemoved((list) => [...list, role.id]);
    setEditing(null);
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

  return (
    <FormDialog
      state={state}
      size="xl"
      title={t("permissions.title", { name: server?.name ?? "" })}
      description={t("permissions.description")}
      submitLabel={tCommon("save")}
      pending={pending}
      isSubmitDisabled={!server || namesMissing || ensuring}
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
        <Tabs.Panel id="roles" className="pt-4">
          {ensuring ? (
            <SectionLoading rows={3} />
          ) : current ? (
            <RoleEditor
              role={current}
              label={roleLabel(current)}
              tools={tools}
              pending={pending}
              onChange={(change) => patch(current, change)}
              onRemove={() => removeRole(current)}
              onBack={() => setEditing(null)}
            />
          ) : (
            <RoleList
              roles={roles}
              tools={tools}
              labelOf={roleLabel}
              pending={pending}
              onEdit={(role) => setEditing(role.id)}
              onAdd={addRole}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel id="tools" className="pt-4">
          <ToolActionsTab
            tools={tools}
            baseTools={baseTools}
            roles={roles}
            suggested={suggested.length}
            pending={pending}
            roleLabel={roleLabel}
            onClassify={classify}
            onAcceptHints={acceptHints}
            onGrant={grant}
          />
        </Tabs.Panel>
      </Tabs>
    </FormDialog>
  );
}
