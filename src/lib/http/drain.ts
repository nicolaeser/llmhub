import "server-only";
import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { gatewayPath } from "@/lib/gateway/api-paths";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const DRAIN_RETRY_SECONDS = 15;
export const UPDATE_DRAIN_MS = 25_000;
export const SHUTDOWN_DRAIN_MS = 320_000;
export const CLOSE_GRACE_MS = 2_000;
export const SETTLE_MS = 1_000;
const REPLACING_LOOKUP_MS = 2_000;
const POLL_MS = 250;
const REQUEST_START = "http.server.request.start";

type RequestStart = { request: IncomingMessage; response: ServerResponse; server: Server };

type DrainState = {
  since: number | null;
  open: number;
  gateway: number;
  tasks: Set<Promise<unknown>>;
  servers: Set<Server>;
  tracking: boolean;
  handling: boolean;
};

type DrainOptions = {
  replacing: () => Promise<boolean>;
  exit?: (code: number) => void;
  pollMs?: number;
  settleMs?: number;
};

const holder = globalThis as typeof globalThis & { __llmhubDrain?: DrainState };

function drainState(): DrainState {
  holder.__llmhubDrain ??= {
    since: null,
    open: 0,
    gateway: 0,
    tasks: new Set(),
    servers: new Set(),
    tracking: false,
    handling: false,
  };
  return holder.__llmhubDrain;
}

export function isGatewayRequest(url: string | undefined): boolean {
  const pathname = (url ?? "").split("?", 1)[0];
  return gatewayPath(pathname).startsWith("/v1/");
}

function onRequestStart(message: unknown) {
  const { request, response, server } = message as RequestStart;
  const state = drainState();
  const gateway = isGatewayRequest(request.url);
  state.servers.add(server);
  state.open += 1;
  if (gateway) state.gateway += 1;
  response.once("close", () => {
    state.open -= 1;
    if (gateway) state.gateway -= 1;
  });
}

export function trackRequests(): void {
  const state = drainState();
  if (state.tracking) return;
  state.tracking = true;
  subscribe(REQUEST_START, onRequestStart);
}

export function isDraining(): boolean {
  return drainState().since !== null;
}

export function holdShutdown<T>(task: Promise<T>): Promise<T> {
  const { tasks } = drainState();
  const tracked = task.finally(() => tasks.delete(tracked));
  tasks.add(tracked);
  tracked.catch(() => undefined);
  return task;
}

async function waitUntil(done: () => boolean, untilMs: number, pollMs: number): Promise<boolean> {
  while (!done()) {
    if (Date.now() >= untilMs) return false;
    await sleep(pollMs);
  }
  return true;
}

async function replacingWithin(replacing: () => Promise<boolean>): Promise<boolean> {
  try {
    return await Promise.race([replacing(), sleep(REPLACING_LOOKUP_MS, false)]);
  } catch (err) {
    logger.warn("server.drain_lookup_failed", errorFields(err));
    return false;
  }
}

export async function drainServer(signal: NodeJS.Signals, options: DrainOptions): Promise<void> {
  const state = drainState();
  if (state.since !== null) return;
  const since = Date.now();
  state.since = since;
  const pollMs = options.pollMs ?? POLL_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  try {
    const replacing = await replacingWithin(options.replacing);
    const budgetMs = replacing ? UPDATE_DRAIN_MS : SHUTDOWN_DRAIN_MS;
    logger.info("server.draining", { signal, replacing, budgetMs, gatewayRequests: state.gateway });
    const idle = () => state.gateway === 0 && state.tasks.size === 0;
    const drained = await waitUntil(idle, since + budgetMs, pollMs);
    for (const server of state.servers) {
      server.close();
      server.closeIdleConnections();
    }
    await waitUntil(() => state.open === 0 && state.tasks.size === 0, Date.now() + CLOSE_GRACE_MS, pollMs);
    await sleep(options.settleMs ?? SETTLE_MS);
    logger.info("server.drained", {
      signal,
      drained,
      durationMs: Date.now() - since,
      ...(drained ? {} : { cutRequests: state.gateway }),
    });
  } catch (err) {
    logger.error("server.drain_failed", errorFields(err));
  } finally {
    exit(signal === "SIGINT" ? 130 : 143);
  }
}

export function installDrainHandler(options: DrainOptions): void {
  const state = drainState();
  if (state.handling) return;
  state.handling = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void drainServer(signal, options));
  }
}
