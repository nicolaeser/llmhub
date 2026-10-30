"use client";

import { useState } from "react";
import { Card, Chip, Disclosure } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { explainAccess } from "@/lib/mcp/resolve";
import type { McpAssignmentView, McpServerPolicy, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { ScopeSelect } from "./access-fields";
import { chainFor } from "./access-view";

const STATE_COLOR = { granted: "success", blocked: "danger", none: "default" } as const;

export default function AccessPreview({
  policy,
  rules,
  options,
  labelOf,
  isDisabled,
}: {
  policy: Pick<McpServerPolicy, "global" | "toolsRestricted" | "allowedTools" | "tools">;
  rules: McpAssignmentView[];
  options: McpTargetOptions;
  labelOf: (rule: Pick<McpAssignmentView, "scope" | "id">) => string;
  isDisabled?: boolean;
}) {
  const tPage = useTranslations("Mcp");
  const t = useTranslations("Mcp.assign");
  const format = useFormatter();
  const [scope, setScope] = useState<AssignmentScope>("key");
  const [id, setId] = useState("");
  const option = options[scope].find((item) => item.id === id) ?? null;
  const explanation = option ? explainAccess(policy, rules, chainFor(scope, option)) : null;
  const sources = (list: McpAssignmentView[]) =>
    list.map((item) => t("source", { scope: item.scope, label: labelOf(item) }));

  return (
    <Disclosure>
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
          {t("preview")}
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="space-y-3 pt-3">
          <p className="text-sm text-muted">{t("previewHint")}</p>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <ScopeSelect
              value={scope}
              onChange={(next) => {
                setScope(next);
                setId("");
              }}
              isDisabled={isDisabled}
            />
            <SearchSelect label={t("target")} items={options[scope]} value={id} onChange={setId} isDisabled={isDisabled} />
          </div>
          {explanation ? (
            <Card variant="secondary">
              <Card.Content className="space-y-2">
                <Chip size="sm" variant="soft" color={STATE_COLOR[explanation.state]}>
                  {t("previewState", { state: explanation.state })}
                </Chip>
                {explanation.grantedBy.length || explanation.global ? (
                  <p className="text-sm text-muted">
                    {t("grantedBy", {
                      sources: format.list(
                        [...(explanation.global ? [t("allCallers")] : []), ...sources(explanation.grantedBy)],
                        { type: "conjunction" },
                      ),
                    })}
                  </p>
                ) : null}
                {explanation.blockedBy.length ? (
                  <p className="text-sm text-danger">
                    {t("blockedAbove", { sources: format.list(sources(explanation.blockedBy), { type: "conjunction" }) })}
                  </p>
                ) : null}
                {explanation.blockedActions.length ? (
                  <p className="text-sm text-muted">
                    {t("previewActions", {
                      list: format.list(
                        explanation.blockedActions.map((action) => tPage("action", { action })),
                        { type: "conjunction" },
                      ),
                    })}
                  </p>
                ) : null}
                {explanation.state === "granted" ? (
                  <p className="text-sm break-words text-muted">
                    {t("previewTools", {
                      count: explanation.tools.length,
                      list: format.list(explanation.tools, { type: "conjunction" }),
                    })}
                  </p>
                ) : null}
              </Card.Content>
            </Card>
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
