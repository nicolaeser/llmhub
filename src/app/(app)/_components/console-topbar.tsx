"use client";

import { Button, Separator } from "@heroui/react";
import { LogOut, Menu, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useBuildStatus } from "./build-status";
import { useConsoleNav } from "./sidebar";

export default function ConsoleTopbar() {
  const t = useTranslations("Common");
  const tNav = useTranslations("Sidebar");
  const nav = useConsoleNav();
  const build = useBuildStatus();
  const health = build?.health ?? "connecting";
  const healthLabel = t("health.status", { status: health });

  return (
    <>
      <header className="flex h-14 items-center gap-3 bg-surface px-4 md:px-6">
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
        <div
          className="flex items-center gap-2 text-sm text-muted"
          role="status"
          aria-label={healthLabel}
        >
          <span
            className={`h-2 w-2 rounded-full ${health === "ok" ? "bg-success" : health === "down" ? "bg-danger" : "bg-accent"}`}
            aria-hidden
          />
          <span className={health === "down" ? "text-danger" : undefined}>
            {healthLabel}
          </span>
        </div>
        <div className="flex-1" />
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
            size="sm"
            variant="ghost"
            aria-label={t("signOut")}
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
