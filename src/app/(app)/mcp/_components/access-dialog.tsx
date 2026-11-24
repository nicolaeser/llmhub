"use client";

import { useEffect, useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpAccessLevel, McpAssignmentView, McpServerView, McpTargetOptions } from "@/types/mcp";
import { loadMcpTargetsAction, saveMcpAssignmentsAction } from "../_action";
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
  const t = useTranslations("Mcp.assign");
  const showError = useErrorToast();
  const [defaultAccess, setDefaultAccess] = useState<McpAccessLevel>(server?.defaultAccess ?? "none");
  const [rules, setRules] = useState<McpAssignmentView[]>(server?.assignments ?? []);
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const [pending, start] = useTransition();
  const isOpen = state.isOpen;

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
        defaultAccess,
        assignments: rules.map((rule) => ({
          scope: rule.scope,
          id: rule.id,
          access: rule.access,
          extraTools: rule.extraTools,
          blockedTools: rule.blockedTools,
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
      size="2xl"
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
        defaultAccess={defaultAccess}
        onDefaultAccess={setDefaultAccess}
        showDefault={platform}
        options={options}
        policy={{
          toolsRestricted: server?.toolsRestricted ?? false,
          allowedTools: server?.allowedTools ?? [],
          tools: server?.tools ?? [],
        }}
        pending={pending}
      />
    </FormDialog>
  );
}
