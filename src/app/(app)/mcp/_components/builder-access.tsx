"use client";

import { useEffect, useState } from "react";
import { Alert } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { MCP_ROLE_KEYS } from "@/schemas/mcp";
import type { HostedTool, McpAssignmentView, McpRoleGrant, McpTargetOptions } from "@/types/mcp";
import { loadMcpTargetsAction } from "../_action";
import { NO_ROLE, type RoleChoice } from "./access-fields";
import AccessRules from "./access-rules";
import { EMPTY_TARGETS } from "./access-view";

const PRESET_ROLES: Record<(typeof MCP_ROLE_KEYS)[number], McpRoleGrant & { key: string; name: string }> = {
  reader: { key: "reader", name: "Reader", allActions: false, actions: ["read"], tools: [], deniedTools: [] },
  operator: { key: "operator", name: "Operator", allActions: false, actions: ["read", "write"], tools: [], deniedTools: [] },
  admin: { key: "admin", name: "Admin", allActions: true, actions: [], tools: [], deniedTools: [] },
};

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
  const showError = useErrorToast();
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const reachable = global || rules.some((rule) => rule.mode === "allow");
  const roles: RoleChoice[] = MCP_ROLE_KEYS.map((key) => ({
    id: key,
    label: tAssign("rolePreset", { role: key }),
    apply: { roleId: "", role: PRESET_ROLES[key] },
  }));

  useEffect(() => {
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
  }, [showError]);

  return (
    <div className="space-y-4">
      {reachable ? null : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("builder.noCaller")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <AccessRules
        rules={rules}
        onRules={onRules}
        global={global}
        onGlobal={onGlobal}
        showGlobal
        options={options}
        policy={{ toolsRestricted: false, allowedTools: [], tools }}
        toolItems={tools.map((tool) => ({
          id: tool.name,
          label: tool.title || tool.name,
          detail: t("builder.toolLine", { method: tool.method, path: tool.path }),
        }))}
        roles={roles}
        roleOf={(rule) => rule.role?.key || NO_ROLE}
        defaultScope="key"
        pending={pending}
      />
    </div>
  );
}
