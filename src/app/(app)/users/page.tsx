"use client";

import { User } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { useActionData } from "@/lib/hooks/use-action-data";
import { loadUserTabsAction } from "./_action";
import RolesTab from "./_components/roles-tab";
import UsersTab from "./_components/users-tab";

export default function UsersPage() {
  const t = useTranslations("Users");
  const page = useActionData(loadUserTabsAction);
  const granted = page.data;

  if (!granted) {
    return <PageStatus icon={User} title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const tabs = [
    ...(granted.includes(PERMISSIONS.USERS_READ) ? [{ id: "users", label: t("tab", { tab: "users" }), panel: <UsersTab /> }] : []),
    ...(granted.includes(PERMISSIONS.ROLES_MANAGE) ? [{ id: "roles", label: t("tab", { tab: "roles" }), panel: <RolesTab /> }] : []),
  ];

  return (
    <div>
      <PageHeader icon={User} title={t("title")} subtitle={t("subtitle")} />
      <PageTabs label={t("title")} tabs={tabs} />
    </div>
  );
}
