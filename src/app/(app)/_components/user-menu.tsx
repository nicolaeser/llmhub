"use client";

import { useRef, useSyncExternalStore, useTransition } from "react";
import { Avatar, Dropdown, Header, Label, Separator, Tooltip } from "@heroui/react";
import { ChevronsUpDown, LogOut, Moon, RefreshCw, Sun, UserRound } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import type { Key } from "react-aria-components";
import { useErrorToast } from "@/components/console/use-error-toast";
import { routing } from "@/i18n/routing";
import { isActionFail } from "@/lib/http/action-result";
import { setLocaleAction } from "../_action";
import { BuildVersion, useBuildStatus } from "./build-status";

export type ConsoleUser = { email: string; username: string };

type Variant = "expanded" | "rail" | "drawer" | "compact";

type Locale = (typeof routing.locales)[number];

const LOCALE_KEY = "locale:";

const PLACEMENT = {
  expanded: "top start",
  drawer: "top start",
  rail: "right bottom",
  compact: "bottom end",
} as const;

const subscribeNever = () => () => {};

function initialsOf(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

export default function UserMenu({ user, variant }: { user: ConsoleUser; variant: Variant }) {
  const t = useTranslations("Sidebar");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const locale = useLocale();
  const showError = useErrorToast();
  const build = useBuildStatus();
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const isDark = mounted ? resolvedTheme !== "light" : true;
  const signOut = useRef<HTMLFormElement>(null);
  const [, startLocale] = useTransition();
  const label = t("userMenu.open", { name: user.username });
  const wide = variant === "expanded" || variant === "drawer";

  function localeName(code: string) {
    return format.displayName(code, { type: "language" }) ?? code.toUpperCase();
  }

  function act(key: Key) {
    if (key === "theme") setTheme(isDark ? "light" : "dark");
    if (key === "status") build?.check();
    if (key === "sign-out") signOut.current?.requestSubmit();
  }

  function chooseLocale(key: Key | undefined) {
    const next = routing.locales.find((code) => `${LOCALE_KEY}${code}` === key);
    if (!next || next === locale) return;
    startLocale(async () => {
      const result = await setLocaleAction(next satisfies Locale);
      if (isActionFail(result)) showError(result.error);
    });
  }

  const avatar = (
    <Avatar size="sm" color="accent" variant="soft">
      <Avatar.Fallback>{initialsOf(user.username)}</Avatar.Fallback>
    </Avatar>
  );

  const trigger = wide ? (
    <Dropdown.Trigger
      aria-label={label}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-foreground/5 motion-safe:transition-colors"
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{user.username}</span>
        <span className="block truncate text-xs text-muted">{user.email}</span>
      </span>
      <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-muted" />
    </Dropdown.Trigger>
  ) : (
    <Dropdown.Trigger aria-label={label} className="rounded-full">
      {avatar}
    </Dropdown.Trigger>
  );

  return (
    <>
      <Dropdown>
        {variant === "rail" ? (
          <Tooltip delay={0} closeDelay={0}>
            {trigger}
            <Tooltip.Content placement="right">{label}</Tooltip.Content>
          </Tooltip>
        ) : (
          trigger
        )}
        <Dropdown.Popover placement={PLACEMENT[variant]} className="min-w-60 max-w-[calc(100vw-2rem)]">
          <Dropdown.Menu aria-label={label} onAction={act}>
            <Dropdown.Section aria-label={user.username}>
              <Header>
                <span className="block text-sm font-medium text-foreground break-words">{user.username}</span>
                <span className="block text-xs text-muted break-words">{user.email}</span>
                <BuildVersion />
              </Header>
              <Dropdown.Item id="account" href="/account" textValue={t("account")}>
                <UserRound size={16} aria-hidden className="shrink-0 text-muted" />
                <Label>{t("account")}</Label>
              </Dropdown.Item>
            </Dropdown.Section>
            <Separator />
            <Dropdown.Section
              aria-label={t("userMenu.language")}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[`${LOCALE_KEY}${locale}`]}
              onSelectionChange={(keys) => {
                if (keys !== "all") chooseLocale([...keys][0]);
              }}
            >
              <Header>{t("userMenu.language")}</Header>
              {routing.locales.map((code) => (
                <Dropdown.Item key={code} id={`${LOCALE_KEY}${code}`} textValue={localeName(code)}>
                  <Label className="flex-1">{localeName(code)}</Label>
                  <Dropdown.ItemIndicator />
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            <Separator />
            <Dropdown.Item id="theme" textValue={tCommon("theme.toggle", { isDark: isDark ? "true" : "false" })}>
              {isDark ? (
                <Sun size={16} aria-hidden className="shrink-0 text-muted" />
              ) : (
                <Moon size={16} aria-hidden className="shrink-0 text-muted" />
              )}
              <Label>{tCommon("theme.toggle", { isDark: isDark ? "true" : "false" })}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="status" textValue={t("userMenu.checkStatus")} isDisabled={!build}>
              <RefreshCw size={16} aria-hidden className="shrink-0 text-muted" />
              <Label>{t("userMenu.checkStatus")}</Label>
            </Dropdown.Item>
            <Separator />
            <Dropdown.Item id="sign-out" textValue={tCommon("signOut")} variant="danger">
              <LogOut size={16} aria-hidden className="shrink-0" />
              <Label>{tCommon("signOut")}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <form ref={signOut} action="/internal-api/account/logout" method="POST" hidden />
    </>
  );
}
