import type { WorkspaceChange } from "@/types/console";

export const WORKSPACE_EVENT = "llmhub-workspace";

export const WORKSPACE_CHANNEL = "llmhub-workspace";

let relay: BroadcastChannel | null = null;

function changeOf(value: unknown): WorkspaceChange | null {
  if (!value || typeof value !== "object") return null;
  const { orgId, alias } = value as Record<string, unknown>;
  if (orgId !== null && typeof orgId !== "string") return null;
  return { orgId: orgId || null, alias: typeof alias === "string" ? alias : "" };
}

function dispatchLocal(change: WorkspaceChange) {
  window.dispatchEvent(new CustomEvent<WorkspaceChange>(WORKSPACE_EVENT, { detail: change }));
}

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(WORKSPACE_CHANNEL);
}

export function notifyWorkspace(change: WorkspaceChange) {
  if (typeof window === "undefined") return;
  dispatchLocal(change);
  if (relay) {
    relay.postMessage(change);
    return;
  }
  const channel = openChannel();
  channel?.postMessage(change);
  channel?.close();
}

export function onWorkspaceChange(listener: (change: WorkspaceChange) => void): () => void {
  const handle = (event: Event) => {
    const change = changeOf((event as CustomEvent<unknown>).detail);
    if (change) listener(change);
  };
  window.addEventListener(WORKSPACE_EVENT, handle);
  return () => window.removeEventListener(WORKSPACE_EVENT, handle);
}

export function relayOtherTabs(): () => void {
  const channel = openChannel();
  if (!channel) return () => {};
  relay = channel;
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const change = changeOf(event.data);
    if (change) dispatchLocal(change);
  };
  return () => {
    if (relay === channel) relay = null;
    channel.close();
  };
}
