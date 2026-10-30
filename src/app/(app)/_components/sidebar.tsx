"use client";

import { createContext, useContext, useId, useState } from "react";
import { Drawer, Separator, Tooltip } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import BrandMark from "@/components/brand/brand-mark";
import { writeSidebarCookie } from "@/lib/utils/sidebar-cookie";
import type { Permission } from "@/types/auth";
import type { NavItem, NavSection } from "@/types/console";
import { BuildNotice } from "./build-status";
import { useConsoleScope } from "./console-scope";
import { homePath, visibleNav } from "./nav-data";
import ScopeSwitcher from "./scope-switcher";
import UserMenu, { type ConsoleUser } from "./user-menu";

type ConsoleNavState = { open: () => void; collapsed: boolean; toggleCollapsed: () => void };

const ConsoleNav = createContext<ConsoleNavState | null>(null);

export function useConsoleNav() {
  return useContext(ConsoleNav);
}

const ITEM_TONE = {
  active: "bg-foreground/8 font-medium text-foreground",
  idle: "text-muted hover:bg-foreground/5 hover:text-foreground",
} as const;

function NavLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const Icon = item.icon;
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const label = t(item.labelKey);
  const tone = active ? ITEM_TONE.active : ITEM_TONE.idle;
  const icon = <Icon size={16} aria-hidden className={active ? "shrink-0 text-accent" : "shrink-0"} />;

  if (collapsed) {
    return (
      <Tooltip delay={0} closeDelay={0}>
        <Tooltip.Trigger<"a">
          className={`flex size-9 items-center justify-center rounded-xl motion-safe:transition-colors ${tone}`}
          render={(props) => (
            <Link {...props} role={undefined} href={item.href} aria-current={active ? "page" : undefined} aria-label={label}>
              {icon}
            </Link>
          )}
        />
        <Tooltip.Content placement="right">{label}</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={`flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm motion-safe:transition-colors ${tone}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function NavItems({
  items,
  collapsed,
  labelledBy,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  labelledBy?: string;
  onNavigate?: () => void;
}) {
  return (
    <ul aria-labelledby={labelledBy} className={collapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-px"}>
      {items.map((item) => (
        <li key={`${item.scope}:${item.href}`}>
          <NavLink item={item} collapsed={collapsed} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

function NavSections({
  sections,
  collapsed,
  onNavigate,
}: {
  sections: NavSection[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");
  const idPrefix = useId();

  if (collapsed) {
    return (
      <div className="flex flex-col gap-2">
        {sections.map((section, index) => (
          <div key={section.id} className="flex flex-col gap-2">
            {index > 0 ? <Separator /> : null}
            <NavItems items={section.items} collapsed />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => {
        const labelId = `${idPrefix}-${section.id}`;
        return (
          <div key={section.id}>
            {section.untitled ? null : (
              <p id={labelId} className="px-2.5 pb-1 text-xs font-medium text-muted">
                {t(section.labelKey)}
              </p>
            )}
            <NavItems
              items={section.items}
              collapsed={false}
              labelledBy={section.untitled ? undefined : labelId}
              onNavigate={onNavigate}
            />
          </div>
        );
      })}
    </div>
  );
}

function ConsoleNavigation({
  permissions,
  collapsed,
  onNavigate,
}: {
  permissions: readonly Permission[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");
  const { kind } = useConsoleScope();
  const sections = visibleNav(permissions, kind);
  const pinned = sections.filter((section) => section.pinned).flatMap((section) => section.items);

  return (
    <nav aria-label={t("primaryNav")} className="flex min-h-0 flex-1 flex-col">
      <div className={`min-h-0 flex-1 overflow-y-auto py-2 ${collapsed ? "px-2" : "px-3"}`}>
        <NavSections
          sections={sections.filter((section) => !section.pinned)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
      {pinned.length ? (
        <div className={collapsed ? "px-2 py-2" : "px-3 py-2"}>
          <NavItems items={pinned} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
      ) : null}
    </nav>
  );
}

function BrandLink({ permissions, collapsed }: { permissions: readonly Permission[]; collapsed: boolean }) {
  const t = useTranslations("Sidebar");
  const { kind } = useConsoleScope();
  return (
    <Link
      href={homePath(permissions, kind)}
      aria-label={t("goHome")}
      className={`flex h-14 shrink-0 items-center gap-2.5 ${collapsed ? "justify-center" : "px-5"}`}
    >
      <BrandMark />
      {collapsed ? null : (
        <span className="truncate text-sm font-semibold tracking-tight text-foreground">{t("appName")}</span>
      )}
    </Link>
  );
}

export default function Sidebar({
  user,
  permissions,
  initialCollapsed,
  children,
}: {
  user: ConsoleUser;
  permissions: readonly Permission[];
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("Sidebar");
  const tCommon = useTranslations("Common");
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawerOpen = drawerPath === pathname;
  const closeDrawer = () => setDrawerPath(null);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeSidebarCookie(next);
  }

  return (
    <ConsoleNav.Provider value={{ open: () => setDrawerPath(pathname), collapsed, toggleCollapsed }}>
      <div className="flex h-svh bg-background text-foreground">
        <aside
          aria-label={t("sidebar")}
          className={`hidden shrink-0 flex-col bg-background md:flex ${collapsed ? "w-16" : "w-60"}`}
        >
          <BrandLink permissions={permissions} collapsed={collapsed} />
          <ScopeSwitcher variant={collapsed ? "rail" : "expanded"} />
          <ConsoleNavigation permissions={permissions} collapsed={collapsed} />
          <Separator />
          <div className={collapsed ? "flex flex-col items-center gap-2 p-2" : "flex flex-col gap-1 p-3"}>
            <div className="empty:hidden">
              <BuildNotice collapsed={collapsed} />
            </div>
            <UserMenu user={user} variant={collapsed ? "rail" : "expanded"} />
          </div>
        </aside>
        <Separator orientation="vertical" className="hidden md:block" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        <Drawer.Backdrop
          variant="blur"
          isOpen={drawerOpen}
          onOpenChange={(open) => setDrawerPath(open ? pathname : null)}
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
              <Drawer.Body className="flex min-h-0 flex-col gap-2 p-0">
                <ScopeSwitcher variant="drawer" />
                <ConsoleNavigation permissions={permissions} collapsed={false} onNavigate={closeDrawer} />
                <Separator />
                <div className="flex flex-col gap-1 p-3">
                  <div className="empty:hidden">
                    <BuildNotice collapsed={false} />
                  </div>
                  <UserMenu user={user} variant="drawer" />
                </div>
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </div>
    </ConsoleNav.Provider>
  );
}
