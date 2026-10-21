import "server-only";
import prisma from "@/lib/db/prisma";
import { SESSION_IDLE_TTL_MS } from "@/lib/auth/cookie";
import { effectivePermissions, hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScopeFor } from "@/lib/auth/scope";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { holdLiveStream, subscribeLive } from "@/lib/updates/live";
import { LIVE_FEEDS } from "@/lib/updates/live-feeds";
import { subscribeTopic } from "@/lib/updates/live-topics";
import { updaterSnapshot } from "@/lib/updates/updater-store";
import { livePayload } from "@/lib/updates/updater-view";
import type { Permission } from "@/types/auth";
import type { LiveFeed, LiveTopic, LiveViewer } from "@/types/live";
import type { SpendScope } from "@/types/structure";
import type { UpdaterSnapshot } from "@/types/updates";

export const LIVE_HEARTBEAT_MS = 15_000;
export const LIVE_RETRY_MS = 3_000;
const ACCESS_RECHECK_MS = 60_000;

export const LIVE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

export type LiveAccess = { canRead: boolean; canManage: boolean; viewer: LiveViewer };

export function liveAccess(permissions: readonly Permission[], scope: SpendScope = {}): LiveAccess {
  return {
    canRead: hasPerm(permissions, PERMISSIONS.SETTINGS_READ),
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
    viewer: { permissions: [...permissions], scope },
  };
}

export function sseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function sessionAccess(workspaceOrgId: string | null) {
  return async (sessionId: string, now: number): Promise<LiveAccess | null> => {
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        expiresAt: true,
        lastActive: true,
        user: {
          select: { id: true, blocked: true, isOwner: true, orgId: true, role: { select: { permissions: true } } },
        },
      },
    });
    if (!row || row.user.blocked || row.expiresAt.getTime() <= now) return null;
    if (now - row.lastActive.getTime() > SESSION_IDLE_TTL_MS) return null;
    const permissions = effectivePermissions({
      isOwner: row.user.isOwner,
      rolePermissions: row.user.role?.permissions ?? [],
      orgId: row.user.orgId,
    });
    const scope = spendScopeFor({
      company: row.user.isOwner ? workspaceOrgId : row.user.orgId,
      seesAll: hasPerm(permissions, PERMISSIONS.SPEND_READ_ALL),
      userId: row.user.id,
    });
    return liveAccess(permissions, scope);
  };
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  try {
    controller.close();
    return true;
  } catch {
    return false;
  }
}

export function liveStream(input: {
  sessionId: string;
  access: LiveAccess;
  signal: AbortSignal;
  topics?: readonly LiveTopic[];
  workspaceOrgId?: string | null;
  heartbeatMs?: number;
  accessCheckMs?: number;
  loadSnapshot?: () => Promise<UpdaterSnapshot>;
  checkAccess?: (sessionId: string, now: number) => Promise<LiveAccess | null>;
  feeds?: Partial<Record<LiveTopic, LiveFeed<unknown>>>;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const loadSnapshot = input.loadSnapshot ?? (() => updaterSnapshot());
  const checkAccess = input.checkAccess ?? sessionAccess(input.workspaceOrgId ?? null);
  const feeds = input.feeds ?? LIVE_FEEDS;
  const topics = new Map<LiveTopic, { key: string; stop: () => void }>();
  let access = input.access;
  let latest: UpdaterSnapshot | null = null;
  let lastSent = "";
  let accessCheckedAt = Date.now();
  let closed = false;
  let unsubscribe = () => {};
  let release = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  function stop(closeStream: boolean) {
    if (closed) return;
    closed = true;
    for (const topic of topics.values()) topic.stop();
    topics.clear();
    unsubscribe();
    release();
    clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onAbort);
    if (closeStream && controllerRef) closeQuietly(controllerRef);
  }

  function onAbort() {
    stop(true);
  }

  function send(text: string) {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(text));
    } catch {
      stop(false);
    }
  }

  function deliver(snapshot: UpdaterSnapshot) {
    latest = snapshot;
    const json = JSON.stringify(livePayload(snapshot, access));
    if (json === lastSent) return;
    lastSent = json;
    send(sseEvent("status", json));
  }

  function syncTopics() {
    for (const topic of input.topics ?? []) {
      const feed = feeds[topic];
      if (!feed || closed) continue;
      const allowed =
        hasPerm(access.viewer.permissions, feed.permission) && !(feed.platformOnly && access.viewer.scope.orgId);
      const key = allowed ? feed.scopeKey(access.viewer.scope) : "";
      const current = topics.get(topic);
      if (current?.key === key) continue;
      if (current) {
        current.stop();
        topics.delete(topic);
      }
      if (!allowed) {
        if (current) send(sseEvent(topic, JSON.stringify({ revoked: true })));
        continue;
      }
      const stopTopic = subscribeTopic(feed, access.viewer.scope, (json) => send(sseEvent(topic, json)));
      topics.set(topic, { key, stop: stopTopic });
    }
  }

  async function recheckAccess(now: number) {
    accessCheckedAt = now;
    try {
      const next = await checkAccess(input.sessionId, now);
      if (!next) {
        send(sseEvent("expired", "{}"));
        stop(true);
        return;
      }
      access = next;
      if (latest) deliver(latest);
      syncTopics();
    } catch (err) {
      logger.warn("live.access_check_failed", errorFields(err));
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (input.signal.aborted) {
        stop(true);
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
      release = holdLiveStream(() => {
        send(sseEvent("restart", "{}"));
        stop(true);
      });
      if (closed) return;
      send(`retry: ${LIVE_RETRY_MS}\n\n`);
      try {
        deliver(await loadSnapshot());
      } catch (err) {
        logger.warn("live.snapshot_failed", errorFields(err));
      }
      if (closed) return;
      unsubscribe = subscribeLive(deliver);
      syncTopics();
      heartbeat = setInterval(() => {
        const now = Date.now();
        send(sseEvent("ping", String(now)));
        if (now - accessCheckedAt >= (input.accessCheckMs ?? ACCESS_RECHECK_MS)) void recheckAccess(now);
      }, input.heartbeatMs ?? LIVE_HEARTBEAT_MS);
    },
    cancel() {
      stop(false);
    },
  });
}
