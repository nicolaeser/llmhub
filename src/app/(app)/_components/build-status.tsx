"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button, toast } from "@heroui/react";
import { ArrowUpCircle, ExternalLink, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { isActionFail } from "@/lib/http/action-result";
import {
  buildInfoOf,
  checkDue,
  FOCUS_CHECK_GAP_MS,
  reloadRequired,
  UPDATE_RECHECK_MS,
  VERSION_POLL_MS,
} from "@/lib/updates/build-change";
import type { BuildInfo, ServerHealth, UpdateStatus } from "@/types/updates";
import { loadUpdateStatusAction } from "../_action";

type BuildStatus = {
  loaded: string;
  served: string | null;
  health: ServerHealth;
  checking: boolean;
  check: () => void;
  update: UpdateStatus | null;
};

const BuildStatusContext = createContext<BuildStatus | null>(null);

export function useBuildStatus() {
  return useContext(BuildStatusContext);
}

function reloadPage() {
  window.location.reload();
}

async function fetchServedBuild(): Promise<BuildInfo | null> {
  try {
    const res = await fetch("/internal-api/version", { cache: "no-store" });
    return res.ok ? buildInfoOf(await res.json()) : null;
  } catch {
    return null;
  }
}

export default function BuildStatusProvider({
  version,
  children,
}: {
  version: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("Common");
  const [health, setHealth] = useState<ServerHealth>("connecting");
  const [served, setServed] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, start] = useTransition();
  const lastCheckAt = useRef<number | null>(null);
  const updateCheckedAt = useRef<number | null>(null);
  const announced = useRef<string | null>(null);

  const check = useCallback(() => {
    lastCheckAt.current = Date.now();
    start(async () => {
      const info = await fetchServedBuild();
      setHealth(info ? "ok" : "down");
      if (!info) return;
      setServed(info.version);
      if (reloadRequired(version, info.version) && announced.current !== info.version) {
        announced.current = info.version;
        toast(t("version.installed"), {
          description: t("version.reloadHint"),
          variant: "accent",
          timeout: 0,
          indicator: <RotateCw size={16} aria-hidden />,
          actionProps: { children: t("version.reload"), onPress: reloadPage },
        });
      }
    });
  }, [t, version]);

  const loadUpdate = useCallback(() => {
    updateCheckedAt.current = Date.now();
    loadUpdateStatusAction().then(
      (result) => {
        if (!isActionFail(result)) setUpdate(result);
      },
      check,
    );
  }, [check]);

  useEffect(() => {
    function tick() {
      if (document.visibilityState === "hidden") return;
      check();
      if (checkDue(updateCheckedAt.current, Date.now(), UPDATE_RECHECK_MS)) loadUpdate();
    }
    function resume() {
      if (checkDue(lastCheckAt.current, Date.now(), FOCUS_CHECK_GAP_MS)) tick();
    }
    tick();
    const poll = setInterval(tick, VERSION_POLL_MS);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [check, loadUpdate]);

  return (
    <BuildStatusContext.Provider
      value={{ loaded: version, served, health, checking, check, update }}
    >
      {children}
    </BuildStatusContext.Provider>
  );
}

export function BuildNotice({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations("Common");
  const status = useBuildStatus();
  if (!status) return null;

  if (reloadRequired(status.loaded, status.served)) {
    return collapsed ? (
      <div className="flex justify-center">
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          aria-label={t("version.reloadLabel")}
          onPress={reloadPage}
        >
          <RotateCw size={14} aria-hidden />
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2.5 px-2 py-1">
        <IconTile icon={RotateCw} tone="success" size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {t("version.ready")}
        </span>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t("version.reloadLabel")}
          onPress={reloadPage}
        >
          {t("version.reload")}
        </Button>
      </div>
    );
  }

  const update = status.update;
  if (!update?.available || !update.url) return null;
  const label = t("version.updateLabel", { version: update.latest ?? "" });
  return (
    <a
      href={update.url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      title={label}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-default ${collapsed ? "justify-center" : ""}`}
    >
      <IconTile icon={ArrowUpCircle} tone="accent" size="sm" />
      {!collapsed ? (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {t("version.updateAvailable")}
            </span>
            <span className="block truncate text-xs text-muted">
              {update.latest}
            </span>
          </span>
          <ExternalLink size={14} aria-hidden className="shrink-0 text-muted" />
        </>
      ) : null}
    </a>
  );
}

export function BuildVersion() {
  const t = useTranslations("Common");
  const status = useBuildStatus();
  if (!status) return null;
  return (
    <p className="truncate px-2 text-xs text-muted" title={status.loaded}>
      {t("version.current", { version: status.loaded })}
    </p>
  );
}
