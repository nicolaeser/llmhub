export const WORKSPACE_EVENT = "llmhub-workspace";

export function notifyWorkspace(orgId: string | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT, { detail: orgId }));
}
