import "server-only";
import { randomUUID } from "node:crypto";
import type { Principal, RequestTrace } from "@/types/gateway";
import type { RequestActivity, RequestActivityKind, RunningRequest } from "@/types/logs";

export const RUNNING_MAX_AGE_MS = 30 * 60_000;

export type RunningEntry = RunningRequest & { orgId: string; userId: string; sessionId: string; startedMs: number };

type ActivityListener = (activity: RequestActivity) => void;

type ActivityHub = {
  running: Map<string, RunningEntry>;
  byTrace: WeakMap<RequestTrace, string>;
  listeners: Set<ActivityListener>;
};

const holder = globalThis as typeof globalThis & { __llmhubRequestActivity?: ActivityHub };

function activityHub(): ActivityHub {
  holder.__llmhubRequestActivity ??= { running: new Map(), byTrace: new WeakMap(), listeners: new Set() };
  return holder.__llmhubRequestActivity;
}

function emit(hub: ActivityHub, kind: RequestActivityKind, dims: Omit<RequestActivity, "kind">): void {
  const activity = { kind, ...dims };
  for (const listener of [...hub.listeners]) listener(activity);
}

export function trackRequest(principal: Principal, request: { model: string; stream: boolean }, now = Date.now()): void {
  const trace = principal.trace;
  if (!trace) return;
  const hub = activityHub();
  if (hub.byTrace.has(trace)) return;
  const entry: RunningEntry = {
    id: randomUUID(),
    startedAt: new Date(now).toISOString(),
    startedMs: now,
    model: request.model,
    endpoint: trace.endpoint,
    stream: request.stream,
    keyId: principal.key?.token_id ?? "",
    agent: principal.client?.agent ?? "",
    orgId: principal.orgId,
    userId: principal.userId,
    sessionId: principal.client?.session ?? "",
  };
  hub.byTrace.set(trace, entry.id);
  hub.running.set(entry.id, entry);
  emit(hub, "start", entry);
}

export function finishRequest(trace: RequestTrace | undefined): void {
  if (!trace) return;
  const hub = activityHub();
  const id = hub.byTrace.get(trace);
  if (!id) return;
  const entry = hub.running.get(id);
  hub.running.delete(id);
  if (entry) emit(hub, "finish", entry);
}

export function announceRequestLog(dims: Omit<RequestActivity, "kind">, trace: RequestTrace | undefined): void {
  const hub = activityHub();
  const id = trace ? hub.byTrace.get(trace) : undefined;
  if (id) hub.running.delete(id);
  emit(hub, "row", dims);
}

export function runningEntries(now = Date.now()): RunningEntry[] {
  const hub = holder.__llmhubRequestActivity;
  if (!hub) return [];
  const live: RunningEntry[] = [];
  for (const [id, entry] of hub.running) {
    if (now - entry.startedMs > RUNNING_MAX_AGE_MS) hub.running.delete(id);
    else live.push(entry);
  }
  return live;
}

export function watchRequestActivity(listener: ActivityListener): () => void {
  const hub = activityHub();
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
  };
}
