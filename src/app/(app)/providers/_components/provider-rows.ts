import type { ProviderView } from "@/types/providers";

export type CredentialState = "stored" | "service_account" | "missing";

export type ProviderStatus = "active" | "paused" | "missing";

export type ProviderMenuAction = "edit" | "import" | "pause" | "resume" | "disconnect";

export type ProviderRow = {
  credential: CredentialState;
  models: number;
  active: boolean;
  internal: boolean;
};

export function credentialState(row: Pick<ProviderView, "hasApiKey" | "vertex">): CredentialState {
  if (!row.hasApiKey) return "missing";
  return row.vertex?.credential === "service_account" ? "service_account" : "stored";
}

export function providerRow(row: ProviderView): ProviderRow {
  return {
    credential: credentialState(row),
    models: row.discovered.length,
    active: row.enabled,
    internal: row.internal,
  };
}

export function providerStatus(row: Pick<ProviderView, "enabled" | "hasApiKey" | "vertex">): ProviderStatus {
  if (!row.enabled) return "paused";
  return credentialState(row) === "missing" ? "missing" : "active";
}

export function providerMatches(row: Pick<ProviderView, "name" | "kind">, query: string, labels: string[] = []): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.name, row.kind, ...labels].some((value) => value.toLocaleLowerCase().includes(needle));
}

export function providerMenuActions(canManage: boolean, row: Pick<ProviderView, "enabled">): ProviderMenuAction[] {
  if (!canManage) return [];
  return ["edit", "import", row.enabled ? "pause" : "resume", "disconnect"];
}

function providerLabel(row: Pick<ProviderView, "name">): string {
  return row.name.toLocaleLowerCase();
}

export function byProviderOrder(
  a: Pick<ProviderView, "id" | "name" | "enabled">,
  b: Pick<ProviderView, "id" | "name" | "enabled">,
): number {
  return (
    Number(!a.enabled) - Number(!b.enabled) ||
    providerLabel(a).localeCompare(providerLabel(b)) ||
    a.id.localeCompare(b.id)
  );
}
