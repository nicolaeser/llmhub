"use client";

import { createContext, useContext, useState } from "react";
import { Button, Disclosure, DisclosureGroup, Drawer, Separator, Tooltip } from "@heroui/react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Key } from "react-aria-components";
import { Link, usePathname } from "@/i18n/routing";
import BrandMark from "@/components/brand/brand-mark";
import { writeSidebarCookie } from "@/lib/utils/sidebar-cookie";
import type { Permission } from "@/types/auth";
import type { NavItem, NavSection } from "@/types/console";
import { BuildNotice, BuildVersion } from "./build-status";
import { useConsoleScope } from "./console-scope";
import { homePath, NAV, visibleNav } from "./nav-data";
import ScopeSwitcher from "./scope-switcher";
import UserMenu, { type ConsoleUser } from "./user-menu";

const ConsoleNav = createContext<{ open: () => void } | null>(null);

export function useConsoleNav() {
  return useContext(ConsoleNav);
}

const ITEM_TONE = {
  active: "bg-accent/12 font-medium text-foreground ring-1 ring-inset ring-accent/25",
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
          className={`flex size-10 items-center justify-center rounded-xl motion-safe:transition-colors ${tone}`}
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
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm motion-safe:transition-colors ${tone}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function NavItems({
  items,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <ul className={collapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-0.5"}>
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
  expanded,
  onExpandedChange,
  onNavigate,
}: {
  sections: NavSection[];
  collapsed: boolean;
  expanded: Set<Key>;
  onExpandedChange: (keys: Set<Key>) => void;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");

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
    <DisclosureGroup allowsMultipleExpanded expandedKeys={expanded} onExpandedChange={onExpandedChange}>
      {sections.map((section) => (
        <Disclosure key={section.id} id={section.id} className="mb-2">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-muted hover:text-foreground">
              <span className="truncate">{t(section.labelKey)}</span>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <div className="pt-1">
              <NavItems items={section.items} collapsed={false} onNavigate={onNavigate} />
            </div>
          </Disclosure.Content>
        </Disclosure>
      ))}
    </DisclosureGroup>
  );
}

function ConsoleNavigation({
  permissions,
  collapsed,
  expanded,
  onExpandedChange,
  onNavigate,
}: {
  permissions: readonly Permission[];
  collapsed: boolean;
  expanded: Set<Key>;
  onExpandedChange: (keys: Set<Key>) => void;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Sidebar");
  const { kind } = useConsoleScope();
  const sections = visibleNav(permissions, kind);
  const pinned = sections.filter((section) => section.pinned).flatMap((section) => section.items);

  return (
    <nav aria-label={t("primaryNav")} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <NavSections
          sections={sections.filter((section) => !section.pinned)}
          collapsed={collapsed}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          onNavigate={onNavigate}
        />
      </div>
      {pinned.length ? (
        <>
          <Separator />
          <div className="p-2">
            <NavItems items={pinned} collapsed={collapsed} onNavigate={onNavigate} />
          </div>
        </>
      ) : null}
    </nav>
  );
}

function BuildStatusSlot() {
  return (
    <div className="flex h-12 flex-col justify-center">
      <BuildNotice collapsed={false} fallback={<BuildVersion />} />
    </div>
  );
}

function BrandLink({ permissions, collapsed }: { permissions: readonly Permission[]; collapsed: boolean }) {
  const t = useTranslations("Sidebar");
  const { kind } = useConsoleScope();
  return (
    <Link
      href={homePath(permissions, kind)}
      aria-label={t("goHome")}
      className={`flex h-14 shrink-0 items-center gap-2.5 ${collapsed ? "justify-center" : "px-3"}`}
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
  const [expanded, setExpanded] = useState<Set<Key>>(() => new Set(NAV.map((section) => section.id)));
  const drawerOpen = drawerPath === pathname;
  const closeDrawer = () => setDrawerPath(null);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeSidebarCookie(next);
  }

  return (
    <ConsoleNav.Provider value={{ open: () => setDrawerPath(pathname) }}>
      <div className="flex h-svh bg-background text-foreground">
        <aside
          aria-label={t("sidebar")}
          className={`hidden shrink-0 flex-col bg-surface md:flex ${collapsed ? "w-16" : "w-64"}`}
        >
          <BrandLink permissions={permissions} collapsed={collapsed} />
          <ScopeSwitcher variant={collapsed ? "rail" : "expanded"} />
          <ConsoleNavigation
            permissions={permissions}
            collapsed={collapsed}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
          <Separator />
          <div className={collapsed ? "flex flex-col items-center gap-2 p-2" : "flex flex-col gap-2 p-2"}>
            {collapsed ? (
              <>
                <div className="flex h-10 items-center justify-center">
                  <BuildNotice collapsed />
                </div>
                <UserMenu user={user} variant="rail" />
                <Tooltip delay={0} closeDelay={0}>
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={t("toggleCollapsed", { collapsed: "true" })}
                    aria-expanded={false}
                    onPress={toggleCollapsed}
                  >
                    <PanelLeftOpen size={16} aria-hidden />
                  </Button>
                  <Tooltip.Content placement="right">{t("toggleCollapsed", { collapsed: "true" })}</Tooltip.Content>
                </Tooltip>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <UserMenu user={user} variant="expanded" />
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={t("toggleCollapsed", { collapsed: "false" })}
                    aria-expanded
                    onPress={toggleCollapsed}
                  >
                    <PanelLeftClose size={16} aria-hidden />
                  </Button>
                </div>
                <BuildStatusSlot />
              </>
            )}
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
                <ConsoleNavigation
                  permissions={permissions}
                  collapsed={false}
                  expanded={expanded}
                  onExpandedChange={setExpanded}
                  onNavigate={closeDrawer}
                />
                <Separator />
                <div className="flex flex-col gap-2 p-2">
                  <UserMenu user={user} variant="drawer" />
                  <BuildStatusSlot />
                </div>
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </div>
    </ConsoleNav.Provider>
  );
}
