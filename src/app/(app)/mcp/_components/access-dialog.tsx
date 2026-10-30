"use client";

import { useEffect, useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpAssignmentView, McpServerView, McpTargetOptions } from "@/types/mcp";
import { loadMcpTargetsAction, saveMcpAssignmentsAction } from "../_action";
import { NO_ROLE, type RoleChoice } from "./access-fields";
import AccessRules from "./access-rules";
import { EMPTY_TARGETS } from "./access-view";

export default function AccessDialog({
  state,
  server,
  platform,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  server: McpServerView | null;
  platform: boolean;
  onSaved: (server: McpServerView) => void;
}) {
  const tPage = useTranslations("Mcp");
  const t = useTranslations("Mcp.assign");
  const showError = useErrorToast();
  const [global, setGlobal] = useState(server?.global ?? false);
  const [rules, setRules] = useState<McpAssignmentView[]>(server?.assignments ?? []);
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const [pending, start] = useTransition();
  const isOpen = state.isOpen;
  const toolItems = (server?.tools ?? []).map((tool) => ({
    id: tool.name,
    label: tool.title || tool.name,
    detail: tool.action ? tPage("action", { action: tool.action }) : undefined,
  }));
  const roles: RoleChoice[] = (server?.roles ?? []).map((role) => ({
    id: role.id,
    label: role.builtin ? t("rolePreset", { role: role.key }) : role.name,
    apply: { roleId: role.id, role },
  }));

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    loadMcpTargetsAction().then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setOptions(EMPTY_TARGETS);
        return;
      }
      setOptions(result.options);
    });
    return () => {
      active = false;
    };
  }, [isOpen, showError]);

  function save(close: () => void) {
    if (!server) return;
    start(async () => {
      const result = await saveMcpAssignmentsAction({
        serverId: server.id,
        global,
        assignments: rules.map((rule) => ({
          scope: rule.scope,
          id: rule.id,
          mode: rule.mode,
          blockedTools: rule.blockedTools,
          blockedActions: rule.blockedActions,
          roleId: rule.mode === "allow" ? rule.roleId : "",
        })),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("title", { name: server?.name ?? "" })}
      description={t("description")}
      submitLabel={t("save")}
      pending={pending}
      isSubmitDisabled={!server || options === null}
      onSubmit={save}
    >
      <AccessRules
        rules={rules}
        onRules={setRules}
        global={global}
        onGlobal={setGlobal}
        showGlobal={platform}
        options={options}
        policy={{
          toolsRestricted: server?.toolsRestricted ?? false,
          allowedTools: server?.allowedTools ?? [],
          tools: server?.tools ?? [],
        }}
        toolItems={toolItems}
        roles={roles}
        roleOf={(rule) => rule.roleId || NO_ROLE}
        pending={pending}
      />
    </FormDialog>
  );
}
