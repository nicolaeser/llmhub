"use client";

import { useEffect, useState } from "react";
import { Alert } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { HostedTool, McpAccessLevel, McpAssignmentView, McpTargetOptions } from "@/types/mcp";
import { loadMcpTargetsAction } from "../_action";
import AccessRules from "./access-rules";
import { EMPTY_TARGETS } from "./access-view";

export default function BuilderAccess({
  tools,
  defaultAccess,
  rules,
  pending,
  onDefaultAccess,
  onRules,
}: {
  tools: HostedTool[];
  defaultAccess: McpAccessLevel;
  rules: McpAssignmentView[];
  pending: boolean;
  onDefaultAccess: (level: McpAccessLevel) => void;
  onRules: (rules: McpAssignmentView[]) => void;
}) {
  const t = useTranslations("Mcp");
  const showError = useErrorToast();
  const [options, setOptions] = useState<McpTargetOptions | null>(null);
  const reachable = defaultAccess !== "none" || rules.some((rule) => rule.access !== "inherit" && rule.access !== "none");

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
        defaultAccess={defaultAccess}
        onDefaultAccess={onDefaultAccess}
        showDefault
        options={options}
        policy={{
          toolsRestricted: false,
          allowedTools: [],
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            action: tool.action,
          })),
        }}
        defaultScope="key"
        pending={pending}
      />
    </div>
  );
}
