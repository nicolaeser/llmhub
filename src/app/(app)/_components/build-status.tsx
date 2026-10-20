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
import { WORKSPACE_EVENT } from "@/lib/auth/workspace-event";
import { isActionFail } from "@/lib/http/action-result";
import { onWantedLiveTopics, receiveLiveEvent, setLiveLink, wantedLiveTopics } from "@/lib/updates/live-client";
import { LIVE_TOPICS, liveUrl } from "@/lib/updates/live-events";
import { parseJsonOrNull } from "@/lib/utils/json";
import {
  buildInfoOf,
  checkDue,
  FOCUS_CHECK_GAP_MS,
  healthOf,
  LIVE_STALE_MS,
  LIVE_URL,
  LIVE_WATCHDOG_MS,
  liveStatusOf,
  reloadRequired,
  UPDATE_RECHECK_MS,
  VERSION_POLL_MS,
} from "@/lib/updates/build-change";
import type {
  BuildInfo,
  LiveLink,
  LiveStatus,
  ServerHealth,
  UpdaterView,
  UpdateStatus,
} from "@/types/updates";
import { loadUpdateStatusAction } from "../_action";
import InstallUpdate from "./install-update";

type BuildStatus = {
  loaded: string;
  served: BuildInfo | null;
  health: ServerHealth;
  checking: boolean;
  check: () => void;
  update: UpdateStatus | null;
  live: LiveStatus | null;
  setUpdater: (view: UpdaterView | null) => void;
};

const RECONNECT_SLOW_MS = 30_000;
const RECONNECT_FAST_FOR_MS = 2 * 60_000;
const PROBE_GAP_MS = 10_000;
const TOPICS_SETTLE_MS = 300;

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
  const [link, setLink] = useState<LiveLink>("connecting");
  const [lostAt, setLostAt] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [served, setServed] = useState<BuildInfo | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, start] = useTransition();
  const updateCheckedAt = useRef<number | null>(null);
  const announced = useRef<string | null>(null);
  const reconnect = useRef<(() => void) | null>(null);

  const announce = useCallback(
    (info: BuildInfo) => {
      setServed(info);
      if (!reloadRequired(version, info.version) || announced.current === info.version) return;
      announced.current = info.version;
      toast(t("version.installed"), {
        description: t("version.reloadHint"),
        variant: "accent",
        timeout: 0,
        indicator: <RotateCw size={16} aria-hidden />,
        actionProps: { children: t("version.reload"), onPress: reloadPage },
      });
    },
    [t, version],
  );

  const check = useCallback(() => {
    start(async () => {
      const info = await fetchServedBuild();
      setReachable(Boolean(info));
      if (!info) return;
      announce(info);
      reconnect.current?.();
    });
  }, [announce]);

  const loadUpdate = useCallback(() => {
    updateCheckedAt.current = Date.now();
    loadUpdateStatusAction().then(
      (result) => {
        if (!isActionFail(result)) setUpdate(result);
      },
      check,
    );
  }, [check]);

  const setUpdater = useCallback((view: UpdaterView | null) => {
    setLive((current) => (current ? { ...current, updater: view } : current));
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      let lastPollAt = 0;
      const poll = () => {
        if (document.visibilityState === "hidden") return;
        lastPollAt = Date.now();
        void fetchServedBuild().then((info) => {
          const now = Date.now();
          setReachable(Boolean(info));
          setLink(info ? "open" : "lost");
          if (!info) {
            setLostAt((current) => current ?? now);
            setClock(now);
            return;
          }
          announce(info);
        });
      };
      const resume = () => {
        if (checkDue(lastPollAt, Date.now(), FOCUS_CHECK_GAP_MS)) poll();
      };
      poll();
      const timer = setInterval(poll, VERSION_POLL_MS);
      window.addEventListener("focus", resume);
      document.addEventListener("visibilitychange", resume);
      return () => {
        clearInterval(timer);
        window.removeEventListener("focus", resume);
        document.removeEventListener("visibilitychange", resume);
      };
    }

    let source: EventSource | null = null;
    let lastEventAt = 0;
    let lost = false;
    let lostSince = 0;
    let lastProbeAt = 0;
    let retryAt = 0;
    let connectedTopics = "";
    let topicsTimer: ReturnType<typeof setTimeout> | undefined;

    const probe = (now: number) => {
      lastProbeAt = now;
      void fetchServedBuild().then((info) => setReachable(Boolean(info)));
    };

    const markLost = () => {
      if (lost) return;
      lost = true;
      const now = Date.now();
      lostSince = now;
      setLink("lost");
      setLiveLink("lost");
      setLostAt(now);
      setClock(now);
      probe(now);
    };

    const markOpen = () => {
      lastEventAt = Date.now();
      lost = false;
      setLink("open");
      setLiveLink("open");
      setReachable(true);
    };

    const connect = () => {
      source?.close();
      lastEventAt = Date.now();
      const slow = lost && lastEventAt - lostSince > RECONNECT_FAST_FOR_MS;
      retryAt = lastEventAt + (slow ? RECONNECT_SLOW_MS : LIVE_WATCHDOG_MS);
      const topics = wantedLiveTopics();
      connectedTopics = topics.join(",");
      const next = new EventSource(liveUrl(LIVE_URL, topics));
      source = next;
      for (const topic of LIVE_TOPICS) {
        next.addEventListener(topic, (event) => {
          markOpen();
          receiveLiveEvent(topic, parseJsonOrNull(event.data));
        });
      }
      next.addEventListener("status", (event) => {
        markOpen();
        const payload = liveStatusOf(parseJsonOrNull(event.data));
        if (!payload) return;
        setLive(payload);
        announce(payload.build);
      });
      next.addEventListener("ping", markOpen);
      next.addEventListener("restart", markLost);
      next.addEventListener("expired", () => {
        next.close();
        markLost();
      });
      next.addEventListener("error", () => {
        if (source === next) markLost();
      });
    };

    const ensureOpen = () => {
      if (document.visibilityState === "hidden") return;
      if (!source || source.readyState === EventSource.CLOSED) connect();
    };

    const watchdog = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (lost) {
        setClock(now);
        if (now - lastProbeAt >= PROBE_GAP_MS) probe(now);
      }
      if (!source || source.readyState === EventSource.CLOSED) {
        if (now >= retryAt) connect();
        return;
      }
      if (now - lastEventAt > LIVE_STALE_MS) {
        markLost();
        connect();
      }
    };

    const visibility = () => {
      if (document.visibilityState !== "hidden") {
        ensureOpen();
        return;
      }
      source?.close();
      source = null;
    };

    const reconnectVisible = () => {
      if (document.visibilityState !== "hidden") connect();
    };

    const topicsChanged = () => {
      clearTimeout(topicsTimer);
      topicsTimer = setTimeout(() => {
        if (wantedLiveTopics().join(",") !== connectedTopics) reconnectVisible();
      }, TOPICS_SETTLE_MS);
    };

    reconnect.current = ensureOpen;
    connect();
    const timer = setInterval(watchdog, LIVE_WATCHDOG_MS);
    const stopTopics = onWantedLiveTopics(topicsChanged);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", ensureOpen);
    window.addEventListener(WORKSPACE_EVENT, reconnectVisible);
    return () => {
      reconnect.current = null;
      clearInterval(timer);
      clearTimeout(topicsTimer);
      stopTopics();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", ensureOpen);
      window.removeEventListener(WORKSPACE_EVENT, reconnectVisible);
      source?.close();
    };
  }, [announce]);

  useEffect(() => {
    function tick() {
      if (document.visibilityState === "hidden") return;
      if (checkDue(updateCheckedAt.current, Date.now(), UPDATE_RECHECK_MS)) loadUpdate();
    }
    tick();
    const timer = setInterval(tick, VERSION_POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [loadUpdate]);

  const health = healthOf({ link, updating: live?.updating ?? false, reachable, lostAt, now: clock });

  return (
    <BuildStatusContext.Provider
      value={{ loaded: version, served, health, checking, check, update, live, setUpdater }}
    >
      {children}
    </BuildStatusContext.Provider>
  );
}

export function BuildNotice({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations("Common");
  const status = useBuildStatus();
  if (!status) return null;

  if (reloadRequired(status.loaded, status.served?.version ?? null)) {
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

  const updater = status.live?.updater;
  if (updater?.connected && !updater.pinned && (updater.available || status.health === "updating")) {
    return (
      <InstallUpdate
        updater={updater}
        canManage={status.live?.canManage ?? false}
        installing={status.health === "updating"}
        latest={status.update?.available ? status.update.latest : null}
        collapsed={collapsed}
        onView={status.setUpdater}
      />
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
