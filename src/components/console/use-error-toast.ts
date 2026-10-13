import { useCallback } from "react";
import { toast } from "@heroui/react";
import { useTranslations } from "next-intl";

export function useErrorToast() {
  const tError = useTranslations("Error");
  return useCallback((code: string) => {
    toast.danger(tError("code", { code }));
  }, [tError]);
}
