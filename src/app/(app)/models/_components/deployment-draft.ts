import type {
  ContextRange,
  ContextWindowView,
  DeploymentDraft,
  DiscoveredPrice,
  ModelGroupView,
  ProviderOpt,
} from "@/types/models";

export const BILLING_MODES = ["routed", "average", "custom"] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export function billingModeOf(value: string | undefined): BillingMode {
  return BILLING_MODES.find((mode) => mode === value) ?? "routed";
}

export function catalogHit(
  providers: ProviderOpt[],
  providerId: string,
  model: string,
): DiscoveredPrice | null {
  const wanted = model.trim();
  if (!providerId || !wanted) return null;
  const rows = providers.find((p) => p.id === providerId)?.discovered ?? [];
  const hit =
    rows.find((row) => row.id === wanted) ??
    rows.find((row) => row.id.endsWith(`/${wanted}`)) ??
    null;
  if (!hit) return null;
  if (
    hit.priceSource === "provider" ||
    hit.costInputPer1k > 0 ||
    hit.costOutputPer1k > 0
  ) {
    return hit;
  }
  return null;
}

export function contextWindowOf(
  providers: ProviderOpt[],
  providerId: string | null,
  model: string,
): ContextWindowView | null {
  if (!providerId) return null;
  return providers.find((p) => p.id === providerId)?.contextWindows?.[model.trim()] ?? null;
}

export function contextRange(windows: (ContextWindowView | null)[]): ContextRange {
  const known = windows.filter((window): window is ContextWindowView => Boolean(window && window.tokens > 0));
  if (!known.length) return { range: "none", min: 0, max: 0, borrowed: "none" };
  const tokens = known.map((window) => window.tokens);
  const min = Math.min(...tokens);
  const max = Math.max(...tokens);
  const estimates = known.filter((window) => window.from !== undefined).length;
  const borrowed = estimates === 0 ? "none" : estimates === known.length ? "all" : "some";
  return { range: min === max ? "single" : "span", min, max, borrowed };
}

export function withCatalogPrice(
  current: DeploymentDraft,
  patch: Partial<DeploymentDraft>,
  providers: ProviderOpt[],
): Partial<DeploymentDraft> {
  if (patch.model === undefined && patch.providerId === undefined) return patch;
  const next = { ...current, ...patch };
  const hit = catalogHit(providers, next.providerId, next.model);
  if (!hit) return patch;
  return {
    ...patch,
    costInput: String(hit.costInputPer1k),
    costOutput: String(hit.costOutputPer1k),
  };
}

export function emptyDep(providers: ProviderOpt[]): DeploymentDraft {
  const p = providers.find((x) => x.hasApiKey) ?? providers[0];
  return {
    kind: p?.kind || "openai_compat",
    baseUrl: p?.baseUrl || "",
    model: "",
    weight: "1",
    costInput: "0",
    costOutput: "0",
    providerId: p?.id || "",
  };
}

export function draftsOf(group: ModelGroupView | null, providers: ProviderOpt[]): DeploymentDraft[] {
  if (!group?.deployments.length) return [emptyDep(providers)];
  return group.deployments.map((d) => ({
    id: d.id,
    kind: d.kind,
    baseUrl: d.baseUrl,
    model: d.model,
    weight: String(d.weight),
    costInput: String(d.costInput || 0),
    costOutput: String(d.costOutput || 0),
    providerId: d.providerId ?? "",
  }));
}

export function deploymentInput(d: DeploymentDraft) {
  return {
    id: d.id,
    kind: d.kind.startsWith("kind:") ? d.kind.slice(5) : d.kind,
    baseUrl: d.baseUrl,
    model: d.model,
    weight: Number(d.weight) || 1,
    costInput: Number(d.costInput) || 0,
    costOutput: Number(d.costOutput) || 0,
    providerId: !d.providerId || d.providerId.startsWith("kind:") ? null : d.providerId,
  };
}
