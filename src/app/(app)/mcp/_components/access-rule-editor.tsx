"use client";

import { useState } from "react";
import { Button, Chip } from "@heroui/react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import MultiPicker from "@/components/console/multi-picker";
import SearchSelect from "@/components/console/search-select";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpAssignmentMode, McpAssignmentView, McpTargetOptions } from "@/types/mcp";
import type { PickerItem } from "@/types/console";
import type { AssignmentScope } from "@/types/providers";
import { ModeField, NO_ROLE, RoleField, ScopeSelect, type RoleChoice } from "./access-fields";
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
  roles,
  defaultScope,
  pending,
  onAdd,
  onBack,
}: {
  rules: McpAssignmentView[];
  options: McpTargetOptions;
  roles: readonly RoleChoice[];
  defaultScope: AssignmentScope;
  pending: boolean;
  onAdd: (rule: McpAssignmentView) => void;
  onBack: () => void;
}) {
  const t = useTranslations("Mcp.assign");
  const [scope, setScope] = useState<AssignmentScope>(defaultScope);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<McpAssignmentMode>("allow");
  const [role, setRole] = useState<RoleChoice | null>(null);
  const taken = new Set(rules.map(ruleKey));
  const candidates = options[scope].filter((item) => !taken.has(ruleKey({ scope, id: item.id })));

  function add() {
    const option = options[scope].find((item) => item.id === target);
    if (!option) return;
    const rule = newRule(scope, option, mode);
    onAdd(mode === "allow" && role ? { ...rule, ...role.apply } : rule);
  }

  return (
    <div className="space-y-4">
      <BackButton onPress={onBack} isDisabled={pending} />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{t("newRule")}</p>
        <p className="text-sm text-muted">{t("newRuleHint")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <ScopeSelect
          value={scope}
          onChange={(next) => {
            setScope(next);
            setTarget("");
          }}
          isDisabled={pending}
        />
        <SearchSelect
          label={t("target")}
          placeholder={t("targetPlaceholder", { scope })}
          items={candidates}
          value={target}
          onChange={setTarget}
          isDisabled={pending}
        />
      </div>
      <ModeField value={mode} onChange={setMode} isDisabled={pending} />
      {mode === "allow" && roles.length ? (
        <RoleField roles={roles} value={role?.id ?? NO_ROLE} onChange={setRole} isDisabled={pending} />
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onPress={add} isDisabled={pending || !target}>
          <Plus size={14} aria-hidden />
          {t("add")}
        </Button>
      </div>
    </div>
  );
}

export function EditRuleView({
  rule,
  label,
  inherited,
  roles,
  roleKey,
  toolItems,
  pending,
  onChange,
  onRemove,
  onBack,
}: {
  rule: McpAssignmentView;
  label: string;
  inherited: { granted: string; blocked: string };
  roles: readonly RoleChoice[];
  roleKey: string;
  toolItems: PickerItem[];
  pending: boolean;
  onChange: (change: Partial<McpAssignmentView>) => void;
  onRemove: () => void;
  onBack: () => void;
}) {
  const tPage = useTranslations("Mcp");
  const t = useTranslations("Mcp.assign");
  const tCommon = useTranslations("Common");
  const actionItems = MCP_ACTIONS.map((action) => ({ id: action, label: tPage("action", { action }) }));

  return (
    <div className="space-y-4">
      <BackButton onPress={onBack} isDisabled={pending} />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold break-words text-foreground">{label}</p>
          <Chip size="sm" variant="soft">
            {t("scope", { scope: rule.scope })}
          </Chip>
        </div>
        {inherited.granted ? <p className="text-xs text-muted">{t("inherited", { sources: inherited.granted })}</p> : null}
        {inherited.blocked ? <p className="text-xs text-danger">{t("blockedAbove", { sources: inherited.blocked })}</p> : null}
      </div>
      <ModeField value={rule.mode} onChange={(mode) => onChange({ mode })} isDisabled={pending} />
      {rule.mode === "allow" && roles.length ? (
        <RoleField
          roles={roles}
          value={roleKey}
          onChange={(choice) => onChange(choice ? choice.apply : { roleId: "", role: null })}
          isDisabled={pending}
        />
      ) : null}
      {toolItems.length ? (
        <MultiPicker
          label={t("blockedTools")}
          description={t("blockedToolsHint", { mode: rule.mode })}
          placeholder={t("blockedToolsPlaceholder")}
          searchLabel={tCommon("search")}
          emptyLabel={tCommon("noResults")}
          items={toolItems}
          selected={rule.blockedTools}
          onChange={(ids) => onChange({ blockedTools: ids })}
          isDisabled={pending}
        />
      ) : null}
      <MultiPicker
        label={t("blockedActions")}
        description={t("blockedActionsHint")}
        placeholder={t("blockedActionsPlaceholder")}
        searchLabel={tCommon("search")}
        emptyLabel={tCommon("noResults")}
        items={actionItems}
        selected={rule.blockedActions}
        onChange={(ids) => onChange({ blockedActions: MCP_ACTIONS.filter((action) => ids.includes(action)) })}
        isDisabled={pending}
      />
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
