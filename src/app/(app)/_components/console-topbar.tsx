"use client";

import { useState, useTransition } from "react";
import { Button, Label, ListBox, Select, Separator } from "@heroui/react";
import { LogOut, Menu, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { notifyWorkspace } from "@/lib/auth/workspace-event";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { setWorkspaceAction } from "../_action";
import { useBuildStatus } from "./build-status";
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
  const [pending, start] = useTransition();
  const [override, setOverride] = useState<string | null>(null);
  const chosen = override !== null && override !== (workspaceOrgId ?? "") ? override : (workspaceOrgId ?? "");
  const health = build?.health ?? "connecting";
  const healthLabel = t("health.status", { status: health });

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
    });
  }

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
        {companies.length ? (
          <Select
            aria-label={tNav("workspaceLabel")}
            className="w-56"
            selectedKey={chosen && companies.some((company) => company.id === chosen) ? chosen : "all"}
            onSelectionChange={(key) => {
              if (key == null) return;
              choose(String(key));
            }}
            isDisabled={pending}
          >
            <Label className="sr-only">{tNav("workspaceLabel")}</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="all" textValue={tNav("workspaceAll")}>
                  {tNav("workspaceAll")}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {companies.map((company) => (
                  <ListBox.Item key={company.id} id={company.id} textValue={company.alias}>
                    {company.alias}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
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
