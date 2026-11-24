"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { classifyTools, isToolAction } from "@/lib/mcp/resolve";
import type { McpServerView, McpToolActions, McpToolSpec } from "@/types/mcp";
import { saveMcpPermissionsAction } from "../_action";
import ToolActionsTab from "./tool-actions-tab";

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
  const [overrides, setOverrides] = useState<McpToolActions | null>(null);
  const [pending, start] = useTransition();
  const toolActions = overrides ?? server?.toolActions ?? {};
  const baseTools = server?.tools ?? [];
  const tools = classifyTools(baseTools, toolActions);
  const suggested = baseTools.filter((tool) => tool.hint && !toolActions[tool.name] && !tool.action);

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
      const result = await saveMcpPermissionsAction({ serverId: server.id, toolActions });
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
      isSubmitDisabled={!server}
      onSubmit={save}
    >
      <ToolActionsTab
        tools={tools}
        baseTools={baseTools}
        suggested={suggested.length}
        pending={pending}
        onClassify={classify}
        onAcceptHints={acceptHints}
      />
    </FormDialog>
  );
}
