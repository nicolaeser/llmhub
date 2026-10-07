"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Separator } from "@heroui/react";
import { ArrowUpCircle, LogOut, Menu, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { loadUpdateStatusAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { UpdateStatus } from "@/types/updates";
import { AssistantTrigger } from "./assistant-session";
import { useConsoleNav } from "./sidebar";

export default function ConsoleTopbar() {
  const t = useTranslations("Common");
  const tNav = useTranslations("Sidebar");
  const nav = useConsoleNav();
  const [health, setHealth] = useState<"connecting" | "ok" | "down">(
    "connecting",
  );
  const [updates, setUpdates] = useState<UpdateStatus | null>(null);
  const [pending, start] = useTransition();

  function ping() {
    start(async () => {
      try {
        const res = await fetch("/internal-api/health");
        if (!res.ok) throw new Error("down");
        const body = (await res.json()) as { status?: string };
        setHealth(body.status === "ok" ? "ok" : "down");
      } catch {
        setHealth("down");
      }
    });
  }

  useEffect(() => {
    ping();
    const id = setInterval(ping, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadUpdateStatusAction().then((result) => {
      if (!isActionFail(result)) setUpdates(result);
    });
  }, []);

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
          {health === "ok" ? (
            updates ? <span>{updates.current}</span> : null
          ) : (
            <span className={health === "down" ? "text-danger" : undefined}>
              {healthLabel}
            </span>
          )}
        </div>
        {updates?.available && updates.url ? (
          <a
            href={updates.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("version.updateLabel", { version: updates.latest ?? "" })}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent"
          >
            <ArrowUpCircle size={14} aria-hidden />
            {t("version.updateAvailable")}
          </a>
        ) : null}
        <div className="flex-1" />
        <AssistantTrigger />
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("refresh")}
          isPending={pending}
          onPress={ping}
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
