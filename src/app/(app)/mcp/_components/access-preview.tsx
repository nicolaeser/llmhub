"use client";

import { useState } from "react";
import { Card, Chip, Disclosure } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { levelColor, useAccessLabels } from "@/components/mcp/access-labels";
import { explainAccess } from "@/lib/mcp/resolve";
import type { McpAssignmentView, McpServerPolicy, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { ScopeSelect } from "./access-fields";
import { chainFor } from "./access-view";

const STATE_COLOR = { granted: "success", blocked: "danger", none: "default" } as const;
const SHOWN_TOOLS = 12;

export default function AccessPreview({
  policy,
  rules,
  options,
  labelOf,
  isDisabled,
}: {
  policy: Pick<McpServerPolicy, "defaultAccess" | "toolsRestricted" | "allowedTools" | "tools">;
  rules: McpAssignmentView[];
  options: McpTargetOptions;
  labelOf: (rule: Pick<McpAssignmentView, "scope" | "id">) => string;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.assign");
  const tAccess = useTranslations("Mcp.access");
  const format = useFormatter();
  const labels = useAccessLabels();
  const [scope, setScope] = useState<AssignmentScope>("key");
  const [id, setId] = useState("");
  const option = options[scope].find((item) => item.id === id) ?? null;
  const named = rules.map((rule) => ({ ...rule, label: labelOf(rule) }));
  const explanation = option ? explainAccess(policy, named, chainFor(scope, option)) : null;
  const path = explanation
    ? [
        ...(explanation.usesDefault ? [`${tAccess("defaultSource")}: ${tAccess("level", { access: policy.defaultAccess })}`] : []),
        ...explanation.steps.map((step) => `${labels.source({ kind: "rule", rule: step })}: ${labels.summary(step)}`),
      ]
    : [];

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
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" variant="soft" color={STATE_COLOR[explanation.state]}>
                    {t("previewState", { state: explanation.state })}
                  </Chip>
                  {explanation.state === "granted" ? (
                    <Chip size="sm" variant="soft" color={levelColor(explanation.level)}>
                      {tAccess("level", { access: explanation.level })}
                    </Chip>
                  ) : null}
                </div>
                {path.length ? (
                  <p className="text-sm break-words text-muted">{t("previewPath", { path: format.list(path, { type: "unit" }) })}</p>
                ) : (
                  <p className="text-sm text-muted">{t("previewNoRule")}</p>
                )}
                {explanation.limitedBy && explanation.state !== "none" ? (
                  <p className="text-sm text-muted">{t("previewLimit", { source: labels.source(explanation.limitedBy) })}</p>
                ) : null}
                {explanation.state === "granted" ? (
                  <p className="text-sm break-words text-muted">
                    {t("previewTools", {
                      count: explanation.tools.length,
                      list: format.list(explanation.tools.slice(0, SHOWN_TOOLS), { type: "conjunction" }),
                      more: Math.max(explanation.tools.length - SHOWN_TOOLS, 0),
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
