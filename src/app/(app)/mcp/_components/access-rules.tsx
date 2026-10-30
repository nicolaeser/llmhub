"use client";

import { useState } from "react";
import { Button, Card, Chip, Description, Label, Separator, Switch } from "@heroui/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { SectionLoading } from "@/components/console/page-status";
import type { PickerItem } from "@/types/console";
import type { McpAssignmentView, McpServerPolicy, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { NO_ROLE, type RoleChoice } from "./access-fields";
import AccessPreview from "./access-preview";
import { AddRuleView, EditRuleView } from "./access-rule-editor";
import { ancestorRules, blocksServer, EMPTY_TARGETS, ruleKey } from "./access-view";

type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; key: string };

export default function AccessRules({
  rules,
  onRules,
  global,
  onGlobal,
  showGlobal,
  options,
  policy,
  toolItems,
  roles,
  roleOf,
  defaultScope = "org",
  pending,
}: {
  rules: McpAssignmentView[];
  onRules: (rules: McpAssignmentView[]) => void;
  global: boolean;
  onGlobal: (global: boolean) => void;
  showGlobal: boolean;
  options: McpTargetOptions | null;
  policy: Pick<McpServerPolicy, "toolsRestricted" | "allowedTools" | "tools">;
  toolItems: PickerItem[];
  roles: readonly RoleChoice[];
  roleOf: (rule: McpAssignmentView) => string;
  defaultScope?: AssignmentScope;
  pending: boolean;
}) {
  const tPage = useTranslations("Mcp");
  const t = useTranslations("Mcp.assign");
  const format = useFormatter();
  const [view, setView] = useState<View>({ kind: "list" });
  const known = options ?? EMPTY_TARGETS;
  const editing = view.kind === "edit" ? rules.find((rule) => ruleKey(rule) === view.key) : undefined;

  function labelOf(rule: Pick<McpAssignmentView, "scope" | "id">): string {
    return (
      rules.find((item) => item.scope === rule.scope && item.id === rule.id)?.label ||
      known[rule.scope].find((item) => item.id === rule.id)?.label ||
      rule.id
    );
  }

  function sources(list: McpAssignmentView[]): string {
    return format.list(
      list.map((item) => t("source", { scope: item.scope, label: labelOf(item) })),
      { type: "conjunction" },
    );
  }

  function inheritance(rule: McpAssignmentView): { granted: string; blocked: string } {
    const ancestors = ancestorRules(rule, rules, known);
    const grants = ancestors.filter((item) => item.mode === "allow");
    const blocks = ancestors.filter(blocksServer);
    const granted = [grants.length ? sources(grants) : "", global ? t("allCallers") : ""].filter(Boolean);
    return {
      granted: granted.length ? format.list(granted, { type: "conjunction" }) : "",
      blocked: blocks.length ? sources(blocks) : "",
    };
  }

  function roleLabel(rule: McpAssignmentView): string {
    const key = roleOf(rule);
    if (key === NO_ROLE) return "";
    return roles.find((role) => role.id === key)?.label ?? rule.role?.name ?? "";
  }

  function summary(rule: McpAssignmentView): string {
    const role = rule.mode === "allow" ? roleLabel(rule) : "";
    const parts = [
      rule.mode === "allow" ? (role ? t("ruleRole", { role }) : t("roleNone")) : "",
      rule.blockedTools.length ? t("ruleTools", { count: rule.blockedTools.length }) : "",
      rule.blockedActions.length
        ? t("ruleActions", {
            list: format.list(
              rule.blockedActions.map((action) => tPage("action", { action })),
              { type: "conjunction" },
            ),
          })
        : "",
    ].filter(Boolean);
    return parts.length ? format.list(parts, { type: "unit" }) : t("blockServerHint");
  }

  function update(key: string, change: Partial<McpAssignmentView>) {
    onRules(rules.map((rule) => (ruleKey(rule) === key ? { ...rule, ...change } : rule)));
  }

  function remove(key: string) {
    onRules(rules.filter((rule) => ruleKey(rule) !== key));
    setView({ kind: "list" });
  }

  if (options === null) return <SectionLoading />;

  if (view.kind === "add") {
    return (
      <AddRuleView
        rules={rules}
        options={known}
        roles={roles}
        defaultScope={defaultScope}
        pending={pending}
        onAdd={(rule) => {
          onRules([...rules, rule]);
          setView({ kind: "list" });
        }}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  if (editing) {
    const key = ruleKey(editing);
    return (
      <EditRuleView
        rule={editing}
        label={labelOf(editing)}
        inherited={inheritance(editing)}
        roles={roles}
        roleKey={roleOf(editing)}
        toolItems={toolItems}
        pending={pending}
        onChange={(change) => update(key, change)}
        onRemove={() => remove(key)}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <div className="space-y-5">
      {showGlobal ? (
        <Switch isSelected={global} onChange={onGlobal} isDisabled={pending}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("global")}</Label>
          </Switch.Content>
          <Description>{t("globalHint")}</Description>
        </Switch>
      ) : null}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{t("rules")}</p>
            <Chip size="sm" variant="soft">
              {format.number(rules.length)}
            </Chip>
          </div>
          <Button size="sm" variant="secondary" onPress={() => setView({ kind: "add" })} isDisabled={pending}>
            <Plus size={14} aria-hidden />
            {t("add")}
          </Button>
        </div>
        {rules.length === 0 ? (
          <p className="text-sm text-muted">{global ? t("noneGlobal") : t("none")}</p>
        ) : (
          <Card variant="secondary">
            <Card.Content className="gap-0">
              <ul aria-label={t("rules")}>
                {rules.map((rule, index) => {
                  const key = ruleKey(rule);
                  const inherited = inheritance(rule);
                  const label = labelOf(rule);
                  return (
                    <li key={key}>
                      {index > 0 ? <Separator /> : null}
                      <div className="flex flex-wrap items-start justify-between gap-3 py-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium break-words text-foreground">{label}</span>
                            <Chip size="sm" variant="soft">
                              {t("scope", { scope: rule.scope })}
                            </Chip>
                            <Chip size="sm" variant="soft" color={rule.mode === "allow" ? "success" : "danger"}>
                              {blocksServer(rule) ? t("blockServer") : t("mode", { mode: rule.mode })}
                            </Chip>
                          </div>
                          <p className="text-xs break-words text-muted">{summary(rule)}</p>
                          {inherited.blocked ? (
                            <p className="text-xs text-danger">{t("blockedAbove", { sources: inherited.blocked })}</p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="tertiary"
                            aria-label={t("edit", { label })}
                            onPress={() => setView({ kind: "edit", key })}
                            isDisabled={pending}
                          >
                            <Pencil size={14} aria-hidden />
                            {t("editShort")}
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="danger-soft"
                            aria-label={t("remove", { label })}
                            isDisabled={pending}
                            onPress={() => remove(key)}
                          >
                            <Trash2 size={14} aria-hidden />
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card.Content>
          </Card>
        )}
      </div>
      <AccessPreview policy={{ ...policy, global }} rules={rules} options={known} labelOf={labelOf} isDisabled={pending} />
    </div>
  );
}
