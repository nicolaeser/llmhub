"use client";

import { useState } from "react";
import { Button, Chip, Table } from "@heroui/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { SectionLoading } from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { levelColor, useAccessLabels } from "@/components/mcp/access-labels";
import { ceilingOf, levelRank } from "@/lib/mcp/resolve";
import type { McpAccessLevel, McpAssignmentView, McpCeiling, McpServerPolicy, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";
import { DefaultAccessSelect } from "./access-fields";
import AccessPreview from "./access-preview";
import { AddRuleView, EditRuleView } from "./access-rule-editor";
import { ancestorRules, EMPTY_TARGETS, ruleKey } from "./access-view";

type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; key: string };

export default function AccessRules({
  rules,
  onRules,
  defaultAccess,
  onDefaultAccess,
  showDefault,
  options,
  policy,
  defaultScope = "org",
  pending,
}: {
  rules: McpAssignmentView[];
  onRules: (rules: McpAssignmentView[]) => void;
  defaultAccess: McpAccessLevel;
  onDefaultAccess: (level: McpAccessLevel) => void;
  showDefault: boolean;
  options: McpTargetOptions | null;
  policy: Pick<McpServerPolicy, "toolsRestricted" | "allowedTools" | "tools">;
  defaultScope?: AssignmentScope;
  pending: boolean;
}) {
  const t = useTranslations("Mcp.assign");
  const tAccess = useTranslations("Mcp.access");
  const format = useFormatter();
  const labels = useAccessLabels();
  const [view, setView] = useState<View>({ kind: "list" });
  const known = options ?? EMPTY_TARGETS;
  const server = { ...policy, defaultAccess };
  const tools = policy.toolsRestricted ? policy.tools.filter((tool) => policy.allowedTools.includes(tool.name)) : policy.tools;
  const editing = view.kind === "edit" ? rules.find((rule) => ruleKey(rule) === view.key) : undefined;

  function labelOf(rule: Pick<McpAssignmentView, "scope" | "id">): string {
    return (
      rules.find((item) => item.scope === rule.scope && item.id === rule.id)?.label ||
      known[rule.scope].find((item) => item.id === rule.id)?.label ||
      rule.id
    );
  }

  function ceilingFor(rule: McpAssignmentView): { above: McpAssignmentView[]; ceiling: McpCeiling } {
    const above = ancestorRules(rule, rules, known).map((item) => ({ ...item, label: labelOf(item) }));
    return { above, ceiling: ceilingOf(server, above) };
  }

  function aboveLine(above: McpAssignmentView[]): string {
    if (!above.length) return tAccess("aboveNone");
    return tAccess("above", {
      list: format.list(
        above.map((item) => `${labels.source({ kind: "rule", rule: item })}: ${labels.summary(item)}`),
        { type: "conjunction" },
      ),
    });
  }

  function limitNote(rule: McpAssignmentView): string {
    if (rule.access === "inherit" || rule.access === "none") return "";
    const { ceiling } = ceilingFor(rule);
    if (!ceiling.level || !ceiling.limitedBy || levelRank(rule.access) <= levelRank(ceiling.level)) return "";
    return tAccess("limited", { level: tAccess("level", { access: ceiling.level }), source: labels.source(ceiling.limitedBy) });
  }

  function update(key: string, change: Partial<McpAssignmentView>) {
    onRules(rules.map((rule) => (ruleKey(rule) === key ? { ...rule, ...change } : rule)));
  }

  function remove(key: string) {
    onRules(rules.filter((rule) => ruleKey(rule) !== key));
    setView({ kind: "list" });
  }

  function levelCell(rule: McpAssignmentView) {
    const note = limitNote(rule);
    return (
      <div className="space-y-1">
        <Chip size="sm" variant="soft" color={levelColor(rule.access)}>
          {labels.level(rule)}
        </Chip>
        {note ? <p className="text-xs text-warning">{note}</p> : null}
      </div>
    );
  }

  function rowActions(rule: McpAssignmentView, label: string) {
    const key = ruleKey(rule);
    return (
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
    );
  }

  if (options === null) return <SectionLoading />;

  if (view.kind === "add") {
    return (
      <AddRuleView
        rules={rules}
        options={known}
        defaultScope={defaultScope}
        pending={pending}
        onAdd={(rule) => {
          onRules([...rules, rule]);
          setView({ kind: "edit", key: ruleKey(rule) });
        }}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  if (editing) {
    const key = ruleKey(editing);
    const { above, ceiling } = ceilingFor(editing);
    return (
      <EditRuleView
        rule={editing}
        label={labelOf(editing)}
        above={aboveLine(above)}
        ceiling={ceiling}
        tools={tools}
        pending={pending}
        onChange={(change) => update(key, change)}
        onRemove={() => remove(key)}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <div className="space-y-5">
      {showDefault ? <DefaultAccessSelect value={defaultAccess} onChange={onDefaultAccess} isDisabled={pending} /> : null}
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
          <p className="text-sm text-muted">{t("none", { access: defaultAccess })}</p>
        ) : (
          <>
            <RowCards label={t("rules")}>
              {rules.map((rule) => {
                const label = labelOf(rule);
                return (
                  <RowCard
                    key={ruleKey(rule)}
                    variant="secondary"
                    title={label}
                    description={t("scope", { scope: rule.scope })}
                    details={[
                      { label: t("columnLevel"), value: levelCell(rule) },
                      { label: t("columnExceptions"), value: labels.exceptions(rule) || t("noExceptions") },
                    ]}
                    actions={rowActions(rule, label)}
                  />
                );
              })}
            </RowCards>
            <Table aria-label={t("rules")} className={TABLE_FROM_LG}>
              <Table.ScrollContainer>
                <Table.Content className="min-w-xl">
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columnTarget")}</Table.Column>
                    <Table.Column>{t("columnLevel")}</Table.Column>
                    <Table.Column>{t("columnExceptions")}</Table.Column>
                    <Table.Column>
                      <span className="sr-only">{t("columnActions")}</span>
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {rules.map((rule) => {
                      const label = labelOf(rule);
                      return (
                        <Table.Row key={ruleKey(rule)} id={ruleKey(rule)}>
                          <Table.Cell>
                            <div className="min-w-0">
                              <p className="text-sm font-medium break-words">{label}</p>
                              <p className="text-xs text-muted">{t("scope", { scope: rule.scope })}</p>
                            </div>
                          </Table.Cell>
                          <Table.Cell>{levelCell(rule)}</Table.Cell>
                          <Table.Cell>
                            <span className="text-sm text-muted">{labels.exceptions(rule) || t("noExceptions")}</span>
                          </Table.Cell>
                          <Table.Cell>{rowActions(rule, label)}</Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </>
        )}
      </div>
      <AccessPreview policy={server} rules={rules} options={known} labelOf={labelOf} isDisabled={pending} />
    </div>
  );
}
