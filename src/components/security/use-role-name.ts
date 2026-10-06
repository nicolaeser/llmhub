import { useCallback } from "react";
import { useTranslations } from "next-intl";

export function useRoleName() {
  const t = useTranslations("Roles");
  return useCallback(
    (role: { templateKey: string | null; name: string | null } | null) => {
      if (!role) return t("noRole");
      if (role.name) return role.name;
      return t("templateName", { key: role.templateKey ?? "other" });
    },
    [t],
  );
}
