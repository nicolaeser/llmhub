"use client";

import { Button, Description, Dropdown, Label } from "@heroui/react";
import { ChevronDown, Plug, Plus, Sparkles, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export type AddChoice = "connect" | "build";

const CHOICES: readonly { id: AddChoice; icon: LucideIcon }[] = [
  { id: "connect", icon: Plug },
  { id: "build", icon: Sparkles },
];

export default function AddServerMenu({ onChoose }: { onChoose: (choice: AddChoice) => void }) {
  const t = useTranslations("Mcp");
  return (
    <Dropdown>
      <Button>
        <Plus size={16} aria-hidden />
        {t("add")}
        <ChevronDown size={14} aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end" className="max-w-xs">
        <Dropdown.Menu
          aria-label={t("add")}
          onAction={(key) => {
            const choice = CHOICES.find((item) => item.id === key);
            if (choice) onChoose(choice.id);
          }}
        >
          {CHOICES.map(({ id, icon: Icon }) => (
            <Dropdown.Item key={id} id={id} textValue={t("addChoice", { choice: id })}>
              <span className="flex h-8 items-start pt-0.5 text-muted">
                <Icon size={16} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col">
                <Label>{t("addChoice", { choice: id })}</Label>
                <Description className="whitespace-normal">{t("addChoiceHint", { choice: id })}</Description>
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
