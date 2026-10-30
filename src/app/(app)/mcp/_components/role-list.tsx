"use client";

import { Button, Card, Chip, Separator } from "@heroui/react";
import { Pencil, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { McpRoleView, McpToolSpec } from "@/types/mcp";
import { roleReach } from "./role-view";

export default function RoleList({
  roles,
  tools,
  labelOf,
  pending,
  onEdit,
  onAdd,
}: {
  roles: McpRoleView[];
  tools: McpToolSpec[];
  labelOf: (role: McpRoleView) => string;
  pending: boolean;
  onEdit: (role: McpRoleView) => void;
  onAdd: () => void;
}) {
  const t = useTranslations("Mcp");
  const format = useFormatter();

  function summary(role: McpRoleView): string {
    const reach = roleReach(role, tools);
    return t("permissions.roleSummary", {
      all: String(role.allActions),
      count: role.actions.length,
      actions: format.list(
        role.actions.map((action) => t("action", { action })),
        { type: "conjunction" },
      ),
      granted: reach.granted,
      total: reach.total,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-sm text-muted">{t("permissions.rolesHint")}</p>
        <Button size="sm" variant="secondary" onPress={onAdd} isDisabled={pending}>
          <Plus size={14} aria-hidden />
          {t("permissions.newRole")}
        </Button>
      </div>
      <Card variant="secondary" className="gap-0">
        <ul aria-label={t("permissions.rolesLabel")}>
          {roles.map((role, index) => {
            const label = labelOf(role);
            const exceptions = roleReach(role, tools).exceptions;
            return (
              <li key={role.id}>
                {index > 0 ? <Separator /> : null}
                <div className={`flex items-start justify-between gap-3 ${index === 0 ? "pb-3" : index === roles.length - 1 ? "pt-3" : "py-3"}`}>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium break-words text-foreground">{label}</span>
                      {role.builtin ? (
                        <Chip size="sm" variant="soft">
                          {t("permissions.builtin")}
                        </Chip>
                      ) : null}
                      {exceptions ? (
                        <Chip size="sm" variant="soft">
                          {t("permissions.exceptions", { count: exceptions })}
                        </Chip>
                      ) : null}
                    </div>
                    <p className="text-xs break-words text-muted">{summary(role)}</p>
                    {role.description ? <p className="text-xs break-words text-muted">{role.description}</p> : null}
                  </div>
                  <Button
                    size="sm"
                    variant="tertiary"
                    aria-label={t("permissions.editRole", { role: label })}
                    onPress={() => onEdit(role)}
                    isDisabled={pending}
                  >
                    <Pencil size={14} aria-hidden />
                    {t("permissions.edit")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
