"use client";

import { Button, Dropdown } from "@heroui/react";
import { Link2, MoreHorizontal, Plus, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { BELOW_MD, useMediaQuery } from "@/lib/hooks/use-media-query";

export default function ProvidersToolbar({
  onImport,
  onCreateLink,
  onAdd,
}: {
  onImport: () => void;
  onCreateLink: () => void;
  onAdd: () => void;
}) {
  const t = useTranslations("Providers.toolbar");
  const compact = useMediaQuery(BELOW_MD);

  if (compact) {
    return (
      <div className="flex w-full items-center gap-2">
        <Button fullWidth onPress={onAdd}>
          <Plus size={16} aria-hidden />
          {t("add")}
        </Button>
        <Dropdown>
          <Button isIconOnly variant="secondary" aria-label={t("more")}>
            <MoreHorizontal size={16} aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={t("more")}
              onAction={(key) => {
                if (key === "import") onImport();
                if (key === "link") onCreateLink();
              }}
            >
              <Dropdown.Item id="import" textValue={t("import")}>
                <Upload size={14} aria-hidden />
                {t("import")}
              </Dropdown.Item>
              <Dropdown.Item id="link" textValue={t("createLink")}>
                <Link2 size={14} aria-hidden />
                {t("createLink")}
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    );
  }

  return (
    <>
      <Button variant="secondary" onPress={onImport}>
        <Upload size={16} aria-hidden />
        {t("import")}
      </Button>
      <Button variant="secondary" onPress={onCreateLink}>
        <Link2 size={16} aria-hidden />
        {t("createLink")}
      </Button>
      <Button onPress={onAdd}>
        <Plus size={16} aria-hidden />
        {t("add")}
      </Button>
    </>
  );
}
