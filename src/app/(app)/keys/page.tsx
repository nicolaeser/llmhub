"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadKeyTabsAction } from "./_action";
import KeysTab from "./_components/keys-tab";
import TemplatesTab from "./_components/templates-tab";

export default function KeysPage() {
  const t = useTranslations("Keys");
  const page = useActionData(loadKeyTabsAction);
  const granted = page.data;

  if (!granted) {
    return <PageStatus icon={KeyRound} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const tabs = [
    ...(granted.includes(PERMISSIONS.KEYS_READ) ? [{ id: "keys", label: t("tab", { tab: "keys" }), panel: <KeysTab /> }] : []),
    ...(granted.includes(PERMISSIONS.MODELS_READ)
      ? [{ id: "templates", label: t("tab", { tab: "templates" }), panel: <TemplatesTab /> }]
      : []),
  ];

  return (
    <div>
      <PageHeader icon={KeyRound} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
