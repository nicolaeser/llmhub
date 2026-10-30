"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { ChevronDown, Link2, ListChecks, Plus, Upload } from "lucide-react";
import { useTranslations } from "next-intl";

const TOOLBAR_ACTIONS = ["import", "createLink", "links"] as const;

type ToolbarAction = (typeof TOOLBAR_ACTIONS)[number];

export default function ProvidersToolbar({
  linkCount,
  onImport,
  onCreateLink,
  onOpenLinks,
  onAdd,
}: {
  linkCount: number | null;
  onImport: () => void;
  onCreateLink: () => void;
  onOpenLinks: () => void;
  onAdd: () => void;
}) {
  const t = useTranslations("Providers.toolbar");

  function run(action: ToolbarAction) {
    if (action === "import") onImport();
    if (action === "createLink") onCreateLink();
    if (action === "links") onOpenLinks();
  }

  return (
    <>
      <Dropdown>
        <Button variant="secondary">
          {t("more")}
          <ChevronDown size={16} aria-hidden />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t("more")}
            onAction={(key) => {
              const action = TOOLBAR_ACTIONS.find((item) => item === key);
              if (action) run(action);
            }}
          >
            <Dropdown.Item id="import" textValue={t("import")}>
              <Upload size={14} aria-hidden />
              <Label>{t("import")}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="createLink" textValue={t("createLink")}>
              <Link2 size={14} aria-hidden />
              <Label>{t("createLink")}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="links" textValue={t("links", { count: linkCount ?? 0 })}>
              <ListChecks size={14} aria-hidden />
              <Label>{t("links", { count: linkCount ?? 0 })}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <Button onPress={onAdd}>
        <Plus size={16} aria-hidden />
        {t("add")}
      </Button>
    </>
  );
}
