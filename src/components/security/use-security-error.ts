import { useCallback } from "react";
import { useTranslations } from "next-intl";

export function useSecurityError() {
  const t = useTranslations("Security");
  return useCallback((code: string) => t("errors.code", { code }), [t]);
}
