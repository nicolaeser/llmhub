"use client";

import { Button, Dropdown, Spinner } from "@heroui/react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

export type RowMenuItem<A extends string> = {
  id: A;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
};

export default function RowMenu<A extends string>({
  label,
  items,
  pending = false,
  onAction,
}: {
  label: string;
  items: RowMenuItem<A>[];
  pending?: boolean;
  onAction: (action: A) => void;
}) {
  if (!items.length) return null;

  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" isPending={pending} aria-label={label}>
        {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />)}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={items.filter((item) => item.disabled).map((item) => item.id)}
          onAction={(key) => {
            const item = items.find((entry) => entry.id === key);
            if (item) onAction(item.id);
          }}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Dropdown.Item
                key={item.id}
                id={item.id}
                textValue={item.label}
                variant={item.danger ? "danger" : "default"}
              >
                <Icon size={14} aria-hidden />
                {item.label}
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
