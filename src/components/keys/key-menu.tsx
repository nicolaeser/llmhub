"use client";

import { Button, Dropdown, Spinner } from "@heroui/react";
import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

export type KeyMenuAction = "edit" | "pause" | "resume" | "mcp" | "budget" | "boost" | "rotate" | "revoke";

export type KeyMenuFlags = { canManage: boolean; canMcp: boolean; canBudget: boolean };

export function keyMenuActions(flags: KeyMenuFlags, key: { capped: boolean; paused: boolean }): KeyMenuAction[] {
  const actions: KeyMenuAction[] = [];
  if (flags.canManage) actions.push("edit", key.paused ? "resume" : "pause");
  if (flags.canMcp) actions.push("mcp");
  if (flags.canBudget) actions.push("budget");
  if (flags.canBudget && key.capped) actions.push("boost");
  if (flags.canManage) actions.push("rotate", "revoke");
  return actions;
}

export function hasKeyMenu(flags: KeyMenuFlags): boolean {
  return flags.canManage || flags.canMcp || flags.canBudget;
}

export default function KeyMenu({
  name,
  actions,
  pending,
  isDisabled,
  onAction,
}: {
  name: string;
  actions: KeyMenuAction[];
  pending: boolean;
  isDisabled?: boolean;
  onAction: (action: KeyMenuAction) => void;
}) {
  const t = useTranslations("Keys");
  const tBudgets = useTranslations("Budgets");

  if (!actions.length) return null;

  function label(action: KeyMenuAction) {
    if (action === "edit") return t("edit");
    if (action === "pause") return t("pause.action");
    if (action === "resume") return t("resume");
    if (action === "mcp") return t("mcp.action");
    if (action === "budget") return t("budget");
    if (action === "boost") return tBudgets("boost.action");
    if (action === "rotate") return t("rotate");
    return t("revoke");
  }

  return (
    <Dropdown>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        isPending={pending}
        isDisabled={isDisabled}
        aria-label={t("actionsMenu", { name })}
      >
        {({ isPending }) =>
          isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />
        }
      </Button>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label={t("actionsMenu", { name })}
          onAction={(key) => {
            const action = actions.find((item) => item === key);
            if (action) onAction(action);
          }}
        >
          {actions.map((action) => (
            <Dropdown.Item
              key={action}
              id={action}
              textValue={label(action)}
              variant={action === "revoke" ? "danger" : "default"}
            >
              {label(action)}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
