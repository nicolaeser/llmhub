import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { updaterSnapshot } from "@/lib/updates/updater-store";
import type { UpdaterSnapshot } from "@/types/updates";

export const LIVE_TICK_MS = 3_000;

type LiveListener = (snapshot: UpdaterSnapshot) => void;

type LiveHub = {
  listeners: Set<LiveListener>;
  closers: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  again: boolean;
  signalsBound: boolean;
  closing: boolean;
};

const holder = globalThis as typeof globalThis & { __llmhubLiveHub?: LiveHub };

function liveHub(): LiveHub {
  holder.__llmhubLiveHub ??= {
    listeners: new Set(),
    closers: new Set(),
    timer: null,
    running: false,
    again: false,
    signalsBound: false,
    closing: false,
  };
  return holder.__llmhubLiveHub;
}

async function broadcast(hub: LiveHub): Promise<void> {
  if (hub.running) {
    hub.again = true;
    return;
  }
  hub.running = true;
  try {
    do {
      hub.again = false;
      const snapshot = await updaterSnapshot();
      for (const listener of hub.listeners) listener(snapshot);
    } while (hub.again && hub.listeners.size);
  } catch (err) {
    logger.warn("live.snapshot_failed", errorFields(err));
  } finally {
    hub.running = false;
  }
}

function closeAll(hub: LiveHub) {
  hub.closing = true;
  for (const close of [...hub.closers]) close();
  hub.closers.clear();
}

function bindShutdown(hub: LiveHub) {
  if (hub.signalsBound) return;
  hub.signalsBound = true;
  process.once("SIGTERM", () => closeAll(hub));
  process.once("SIGINT", () => closeAll(hub));
}

export function publishLive(): void {
  const hub = liveHub();
  if (hub.listeners.size) void broadcast(hub);
}

export function subscribeLive(listener: LiveListener): () => void {
  const hub = liveHub();
  hub.listeners.add(listener);
  if (!hub.timer) {
    hub.timer = setInterval(() => void broadcast(hub), LIVE_TICK_MS);
    hub.timer.unref?.();
  }
  return () => {
    hub.listeners.delete(listener);
    if (hub.listeners.size || !hub.timer) return;
    clearInterval(hub.timer);
    hub.timer = null;
  };
}

export function liveClosing(): boolean {
  return liveHub().closing;
}

export function holdLiveStream(close: () => void): () => void {
  const hub = liveHub();
  if (hub.closing) {
    close();
    return () => undefined;
  }
  bindShutdown(hub);
  hub.closers.add(close);
  return () => {
    hub.closers.delete(close);
  };
}
