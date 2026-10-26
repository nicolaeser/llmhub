"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import KeysTab from "./_components/keys-tab";

export default function KeysPage() {
  const t = useTranslations("Keys");

  return (
    <div>
      <PageHeader icon={KeyRound} title={t("title")} subtitle={t("subtitle")} />
      <KeysTab />
    </div>
  );
}
