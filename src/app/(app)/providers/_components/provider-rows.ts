import type { ProviderView } from "@/types/providers";

export type CredentialState = "stored" | "service_account" | "missing";

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
