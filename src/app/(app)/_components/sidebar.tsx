"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  Button,
  Disclosure,
  DisclosureGroup,
  Drawer,
  Separator,
  useOverlayState,
} from "@heroui/react";
import { PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Key } from "react-aria-components";
import { Link, usePathname } from "@/i18n/routing";
import BrandMark from "@/components/brand/brand-mark";
import LanguageSwitcher from "./language-switcher";
import ThemeSwitcher from "./theme-switcher";
import { hasPerm } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";
import type { NavSection } from "@/types/console";
import { NAV } from "./nav-data";

const ConsoleNav = createContext<{ open: () => void } | null>(null);

export function useConsoleNav() {
  return useContext(ConsoleNav);
}

function NavItems({
  items,
  collapsed,
  onNavigate,
}: {
  items: NavSection["items"];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();

  return items.map((item) => {
    const Icon = item.icon;
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        aria-label={t(item.labelKey)}
        title={t(item.labelKey)}
        onClick={onNavigate}
        className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition ${active ? "bg-accent/10 font-medium text-foreground ring-1 ring-accent/20" : "text-muted hover:bg-default hover:text-foreground"}`}
      >
        <Icon size={16} aria-hidden className={active ? "text-accent" : ""} />
        {!collapsed ? <span className="truncate">{t(item.labelKey)}</span> : null}
      </Link>
    );
  });
}

function NavList({
  collapsed,
  permissions,
  expandedSections,
  onExpandedSectionsChange,
  onNavigate,
}: {
  collapsed: boolean;
  permissions: readonly Permission[];
  expandedSections: Set<Key>;
  onExpandedSectionsChange: (keys: Set<Key>) => void;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");
  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => hasPerm(permissions, item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {collapsed ? (
        sections.map((section) => (
          <div key={section.id} className="mb-4">
            <NavItems items={section.items} collapsed />
          </div>
        ))
      ) : (
        <DisclosureGroup
          allowsMultipleExpanded
          expandedKeys={expandedSections}
          onExpandedChange={onExpandedSectionsChange}
        >
          {sections.map((section) => (
            <Disclosure key={section.id} id={section.id} className="mb-2">
              <Disclosure.Trigger className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-muted hover:text-foreground">
                <span className="truncate">{t(section.labelKey)}</span>
                <Disclosure.Indicator />
              </Disclosure.Trigger>
              <Disclosure.Content>
                <div className="p-1">
                  <NavItems
                    items={section.items}
                    collapsed={false}
                    onNavigate={onNavigate}
                  />
                </div>
              </Disclosure.Content>
            </Disclosure>
          ))}
        </DisclosureGroup>
      )}
    </nav>
  );
}

function RailFooter({
  user,
  collapsed,
  onToggle,
}: {
  user: { email: string; username: string };
  collapsed: boolean;
  onToggle?: () => void;
}) {
  const t = useTranslations("Sidebar");
  return (
    <>
      <Separator />
      <div className="space-y-2 p-2">
        {!collapsed ? <LanguageSwitcher /> : null}
        <div className="flex items-center justify-between gap-1">
          <ThemeSwitcher />
          {onToggle ? (
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              aria-label={t("toggleCollapsed", {
                collapsed: collapsed ? "true" : "false",
              })}
              aria-expanded={!collapsed}
              onPress={onToggle}
              className="text-muted"
            >
              {collapsed ? (
                <PanelLeftOpen size={16} aria-hidden />
              ) : (
                <PanelLeftClose size={16} aria-hidden />
              )}
            </Button>
          ) : null}
        </div>
        <Link
          href="/account"
          aria-label={t("account")}
          title={user.email}
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-default hover:text-foreground ${collapsed ? "justify-center" : ""}`}
        >
          <UserRound size={14} aria-hidden />
          {!collapsed ? <span className="truncate">{user.username}</span> : null}
        </Link>
      </div>
    </>
  );
}

export default function Sidebar({
  user,
  permissions,
  children,
}: {
  user: { email: string; username: string };
  permissions: readonly Permission[];
  children: React.ReactNode;
}) {
  const t = useTranslations("Sidebar");
  const tCommon = useTranslations("Common");
  const pathname = usePathname();
  const drawer = useOverlayState();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<Key>>(
    () => new Set(NAV.map((section) => section.id)),
  );
  const setDrawerOpen = drawer.setOpen;

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, setDrawerOpen]);

  return (
    <ConsoleNav.Provider value={{ open: drawer.open }}>
      <div className="flex h-svh bg-background text-foreground">
        <aside
          aria-label={t("primaryNav")}
          className={`hidden shrink-0 flex-col bg-surface md:flex ${collapsed ? "w-16" : "w-64"}`}
        >
          <Link
            href="/keys"
            aria-label={t("goHome")}
            className="flex h-14 items-center gap-2.5 px-3"
          >
            <BrandMark />
            {!collapsed ? (
              <span className="truncate text-sm font-semibold tracking-tight text-foreground">
                {t("appName")}
              </span>
            ) : null}
          </Link>
          <NavList
            collapsed={collapsed}
            permissions={permissions}
            expandedSections={expandedSections}
            onExpandedSectionsChange={setExpandedSections}
          />
          <RailFooter
            user={user}
            collapsed={collapsed}
            onToggle={() => setCollapsed((v) => !v)}
          />
        </aside>
        <Separator orientation="vertical" className="hidden md:block" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        <Drawer.Backdrop
          variant="blur"
          isOpen={drawer.isOpen}
          onOpenChange={drawer.setOpen}
        >
          <Drawer.Content placement="left">
            <Drawer.Dialog>
              <Drawer.CloseTrigger aria-label={tCommon("close")} />
              <Drawer.Header>
                <Drawer.Heading className="flex items-center gap-2.5">
                  <BrandMark />
                  {t("appName")}
                </Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body className="flex min-h-0 flex-col p-0">
                <NavList
                  collapsed={false}
                  permissions={permissions}
                  expandedSections={expandedSections}
                  onExpandedSectionsChange={setExpandedSections}
                  onNavigate={drawer.close}
                />
                <RailFooter user={user} collapsed={false} />
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </div>
    </ConsoleNav.Provider>
  );
}
