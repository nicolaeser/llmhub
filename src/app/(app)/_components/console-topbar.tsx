"use client";

import { Breadcrumbs, Button, Separator, Tooltip } from "@heroui/react";
import { Building2, Menu, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "@/i18n/routing";
import BrandMark from "@/components/brand/brand-mark";
import type { Permission } from "@/types/auth";
import { useConsoleScope } from "./console-scope";
import LiveBadge from "./live-badge";
import { homePath, navItemFor } from "./nav-data";
import { useConsoleNav } from "./sidebar";
import UserMenu, { type ConsoleUser } from "./user-menu";

export default function ConsoleTopbar({
  user,
  permissions,
}: {
  user: ConsoleUser;
  permissions: readonly Permission[];
}) {
  const t = useTranslations("Sidebar");
  const nav = useConsoleNav();
  const pathname = usePathname();
  const { scope, kind, shown } = useConsoleScope();
  const item = navItemFor(pathname, kind);
  const title = item ? t(item.labelKey) : pathname === "/account" || pathname.startsWith("/account/") ? t("account") : "";
  const nested = item ? pathname !== item.href : false;
  const alias = scope.kind === "company" ? scope.alias : "";
  const scopeLabel = t("scope.label", { kind, alias });
  const ScopeIcon = kind === "company" ? Building2 : ShieldCheck;
  const toggleLabel = t("toggleCollapsed", { collapsed: nav?.collapsed ? "true" : "false" });
  const ToggleIcon = nav?.collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1.5 bg-background px-3 sm:gap-2 sm:px-4 md:px-5">
        {nav ? (
          <Button isIconOnly size="sm" variant="ghost" aria-label={t("openMenu")} onPress={nav.open} className="md:hidden">
            <Menu size={16} aria-hidden />
          </Button>
        ) : null}
        {nav ? (
          <div className="hidden items-center gap-3 md:flex">
            <Tooltip delay={300} closeDelay={0}>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={toggleLabel}
                aria-expanded={!nav.collapsed}
                onPress={nav.toggleCollapsed}
              >
                <ToggleIcon size={16} aria-hidden />
              </Button>
              <Tooltip.Content placement="bottom start">{toggleLabel}</Tooltip.Content>
            </Tooltip>
            <Separator orientation="vertical" className="h-4" />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2 md:hidden">
          <BrandMark />
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">{title || t("appName")}</span>
        </div>
        <Breadcrumbs aria-label={t("location")} className="hidden min-w-0 flex-1 md:flex">
          <Breadcrumbs.Item href={homePath(permissions, kind)}>{scopeLabel}</Breadcrumbs.Item>
          {title ? (
            <Breadcrumbs.Item href={nested && item ? item.href : undefined}>{title}</Breadcrumbs.Item>
          ) : null}
          {nested ? <Breadcrumbs.Item>{t("details")}</Breadcrumbs.Item> : null}
        </Breadcrumbs>
        {nav && shown ? (
          <Button
            size="sm"
            variant="tertiary"
            aria-label={t("scope.openDrawer", { current: scopeLabel })}
            onPress={nav.open}
            className="max-w-28 md:hidden"
          >
            <ScopeIcon size={14} aria-hidden className="shrink-0" />
            <span className="truncate">{alias || t("scope.platform")}</span>
          </Button>
        ) : null}
        <LiveBadge />
        <div className="flex md:hidden">
          <UserMenu user={user} variant="compact" />
        </div>
      </header>
      <Separator />
    </>
  );
}
