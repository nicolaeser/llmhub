"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { useConsoleScope } from "../_components/console-scope";

export default function KeysLoading() {
  const t = useTranslations("Keys");
  const { kind, canSwitch } = useConsoleScope();
  return (
    <PageLoading icon={KeyRound} title={t("title")} subtitle={t("subtitle")} tabs={kind === "platform" || canSwitch} stats={4} />
  );
}
