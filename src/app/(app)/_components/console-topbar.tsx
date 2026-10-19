"use client";

import { useState, useTransition } from "react";
import { Button, Description, Header, Label, ListBox, Select, Separator } from "@heroui/react";
import { Building2, LogOut, Menu, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/routing";
import { notifyWorkspace } from "@/lib/auth/workspace-event";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { setWorkspaceAction } from "../_action";
import { useBuildStatus } from "./build-status";
import LiveBadge from "./live-badge";
import { adminOnlyPath } from "./nav-data";
import { useConsoleNav } from "./sidebar";

export default function ConsoleTopbar({
  companies = [],
  workspaceOrgId = null,
}: {
  companies?: { id: string; alias: string }[];
  workspaceOrgId?: string | null;
}) {
  const t = useTranslations("Common");
  const tNav = useTranslations("Sidebar");
  const nav = useConsoleNav();
  const build = useBuildStatus();
  const showError = useErrorToast();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [override, setOverride] = useState<string | null>(null);
  const chosen = override !== null && override !== (workspaceOrgId ?? "") ? override : (workspaceOrgId ?? "");
  const selectedKey = chosen && companies.some((company) => company.id === chosen) ? chosen : "all";

  function choose(key: string) {
    const next = key === "all" ? "" : key;
    if (next === chosen) return;
    setOverride(next);
    start(async () => {
      const result = await setWorkspaceAction(next);
      if (isActionFail(result)) {
        setOverride(null);
        showError(result.error);
        return;
      }
      notifyWorkspace(result.orgId);
      if (result.orgId && adminOnlyPath(pathname)) router.replace("/companies");
    });
  }

  return (
    <>
      <header className="flex h-14 items-center gap-2 bg-surface px-3 sm:gap-3 sm:px-4 md:px-6">
        {nav ? (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={tNav("openMenu")}
            onPress={nav.open}
            className="md:hidden"
          >
            <Menu size={16} aria-hidden />
          </Button>
        ) : null}
        <LiveBadge />
        <div className="flex-1" />
        {companies.length ? (
          <Select
            aria-label={tNav("workspaceLabel")}
            className="w-36 sm:w-60"
            selectedKey={selectedKey}
            onSelectionChange={(key) => {
              if (key == null) return;
              choose(String(key));
            }}
            isDisabled={pending}
          >
            <Label className="sr-only">{tNav("workspaceLabel")}</Label>
            <Select.Trigger className="items-center gap-2">
              {selectedKey === "all" ? (
                <ShieldCheck size={14} aria-hidden className="shrink-0 text-accent" />
              ) : (
                <Building2 size={14} aria-hidden className="shrink-0 text-muted" />
              )}
              <Select.Value className="truncate">{({ selectedText }) => selectedText}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="min-w-64">
              <ListBox>
                <ListBox.Item id="all" textValue={tNav("workspaceAdmin")}>
                  <ShieldCheck size={16} aria-hidden className="shrink-0 text-accent" />
                  <div className="flex min-w-0 flex-col">
                    <Label>{tNav("workspaceAdmin")}</Label>
                    <Description>{tNav("workspaceAdminHint")}</Description>
                  </div>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Section>
                  <Header>{tNav("workspaceCompanies")}</Header>
                  {companies.map((company) => (
                    <ListBox.Item key={company.id} id={company.id} textValue={company.alias}>
                      <Building2 size={16} aria-hidden className="shrink-0 text-muted" />
                      <div className="flex min-w-0 flex-col">
                        <Label className="truncate">{company.alias}</Label>
                        <Description>{tNav("workspaceCompanyHint")}</Description>
                      </div>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              </ListBox>
            </Select.Popover>
          </Select>
        ) : null}
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("refresh")}
          isPending={build?.checking}
          isDisabled={!build}
          onPress={build?.check}
        >
          <RefreshCw size={14} aria-hidden />
        </Button>
        <form action="/internal-api/account/logout" method="POST">
          <Button
            type="submit"
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t("signOut")}
            className="sm:hidden"
          >
            <LogOut size={14} aria-hidden />
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            aria-label={t("signOut")}
            className="max-sm:hidden"
          >
            <LogOut size={14} aria-hidden />
            {t("signOut")}
          </Button>
        </form>
      </header>
      <Separator />
    </>
  );
}
