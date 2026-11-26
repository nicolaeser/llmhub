"use client";

import { useState } from "react";
import { Button, Chip, Separator } from "@heroui/react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import AccessLevelField from "@/components/mcp/access-level-field";
import { useAccessLabels } from "@/components/mcp/access-labels";
import ToolAccessList from "@/components/mcp/tool-access-list";
import type { McpAssignmentView, McpCeiling, McpTargetOptions, McpToolSpec } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { ScopeSelect } from "./access-fields";
import { newRule, ruleKey } from "./access-view";

function BackButton({ onPress, isDisabled }: { onPress: () => void; isDisabled?: boolean }) {
  const t = useTranslations("Mcp.assign");
  return (
    <Button size="sm" variant="ghost" className="self-start" onPress={onPress} isDisabled={isDisabled}>
      <ArrowLeft size={14} aria-hidden />
      {t("back")}
    </Button>
  );
}

export function AddRuleView({
  rules,
  options,
  defaultScope,
  pending,
  onAdd,
  onBack,
}: {
  rules: McpAssignmentView[];
  options: McpTargetOptions;
  defaultScope: AssignmentScope;
  pending: boolean;
  onAdd: (rule: McpAssignmentView) => void;
  onBack: () => void;
}) {
  const t = useTranslations("Mcp.assign");
  const [scope, setScope] = useState<AssignmentScope>(defaultScope);
  const taken = new Set(rules.map(ruleKey));
  const candidates = options[scope].filter((item) => !taken.has(ruleKey({ scope, id: item.id })));

  function choose(id: string) {
    const option = options[scope].find((item) => item.id === id);
    if (option) onAdd(newRule(scope, option, "read"));
  }

  return (
    <div className="space-y-4">
      <BackButton onPress={onBack} isDisabled={pending} />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{t("newRule")}</p>
        <p className="text-sm text-muted">{t("newRuleHint")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <ScopeSelect value={scope} onChange={setScope} isDisabled={pending} />
        <SearchSelect
          label={t("target")}
          placeholder={t("targetPlaceholder", { scope })}
          items={candidates}
          value=""
          onChange={choose}
          isDisabled={pending}
        />
      </div>
    </div>
  );
}

export function EditRuleView({
  rule,
  label,
  above,
  ceiling,
  tools,
  pending,
  onChange,
  onRemove,
  onBack,
}: {
  rule: McpAssignmentView;
  label: string;
  above: string;
  ceiling: McpCeiling;
  tools: McpToolSpec[];
  pending: boolean;
  onChange: (change: Partial<McpAssignmentView>) => void;
  onRemove: () => void;
  onBack: () => void;
}) {
  const t = useTranslations("Mcp.assign");
  const labels = useAccessLabels();

  return (
    <div className="space-y-5">
      <BackButton onPress={onBack} isDisabled={pending} />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold break-words text-foreground">{label}</p>
          <Chip size="sm" variant="soft">
            {t("scope", { scope: rule.scope })}
          </Chip>
        </div>
        <p className="text-xs text-muted">{above}</p>
      </div>
      <AccessLevelField
        value={rule.access}
        onChange={(access) => onChange({ access, extraTools: [], blockedTools: access === "none" ? [] : rule.blockedTools })}
        context="rule"
        ceiling={ceiling.level}
        ceilingSource={ceiling.limitedBy ? labels.source(ceiling.limitedBy) : undefined}
        isDisabled={pending}
      />
      <Separator />
      <ToolAccessList tools={tools} grant={rule} ceiling={ceiling} onChange={onChange} isDisabled={pending} />
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="danger-soft" onPress={onRemove} isDisabled={pending}>
          <Trash2 size={14} aria-hidden />
          {t("removeRule")}
        </Button>
        <Button variant="secondary" onPress={onBack} isDisabled={pending}>
          {t("done")}
        </Button>
      </div>
    </div>
  );
}
