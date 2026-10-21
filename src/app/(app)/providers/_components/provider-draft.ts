import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import {
  MAX_VERTEX_CREDENTIAL_CHARS,
  serviceAccountSummary,
  VERTEX_DEFAULT_LOCATION,
} from "@/lib/gateway/upstreams/vertex-target";
import type {
  ProviderBody,
  ProviderDraft,
  ProviderKindSpec,
  ProviderView,
  VertexDraft,
  VertexView,
} from "@/types/providers";

const RETENTION_DAYS = /^\d{0,4}$/;

export function vertexDraftReady(draft: VertexDraft, apiKey: string, current: VertexView | null): boolean {
  const switched = current !== null && current.credential !== draft.credential;
  if (draft.credential === "api_key") return Boolean(apiKey.trim()) || (current !== null && !switched);
  const text = draft.serviceAccount.trim();
  if (!text) return current !== null && !switched && Boolean(draft.project.trim() && draft.location.trim());
  return (
    text.length <= MAX_VERTEX_CREDENTIAL_CHARS &&
    serviceAccountSummary(text) !== null &&
    Boolean(draft.project.trim() && draft.location.trim())
  );
}

export function draftFor(spec: ProviderKindSpec | null, editing: ProviderView | null, name: string): ProviderDraft {
  const vertex = editing?.vertex ?? null;
  const policy = editing?.policy ?? null;
  return {
    name: editing?.name ?? name,
    baseUrl: editing?.baseUrl ?? spec?.default_base_url ?? "",
    apiKey: "",
    signIn: "",
    vertex: {
      credential: vertex?.credential ?? "service_account",
      serviceAccount: "",
      project: vertex?.project ?? "",
      location: vertex?.location || VERTEX_DEFAULT_LOCATION,
    },
    zdr: policy?.zdr ?? false,
    retention: !policy || policy.zdr || policy.retentionDays === null ? "" : String(policy.retentionDays),
    region: policy?.region ?? (spec?.kind === "openrouter_eu" ? "eu" : ""),
    noTraining: policy?.noTraining ?? false,
    internal: editing?.internal ?? false,
  };
}

export function retentionValid(draft: ProviderDraft): boolean {
  return draft.zdr || RETENTION_DAYS.test(draft.retention.trim());
}

export function draftReady(spec: ProviderKindSpec | null, editing: ProviderView | null, draft: ProviderDraft): boolean {
  if (!spec || !retentionValid(draft)) return false;
  if (isSignInKind(spec.kind)) return editing !== null || Boolean(draft.signIn);
  if (spec.kind === "vertex") return vertexDraftReady(draft.vertex, draft.apiKey, editing?.vertex ?? null);
  return true;
}

export function draftBody(spec: ProviderKindSpec, draft: ProviderDraft): ProviderBody {
  const retention = draft.retention.trim();
  const vertex = spec.kind === "vertex";
  const serviceAccount = vertex && draft.vertex.credential === "service_account";
  return {
    name: draft.name,
    kind: spec.kind,
    baseUrl: vertex || isSignInKind(spec.kind) ? "" : draft.baseUrl.trim(),
    apiKey: serviceAccount ? draft.vertex.serviceAccount : draft.apiKey,
    signIn: draft.signIn || undefined,
    policy: {
      zdr: draft.zdr,
      retentionDays: draft.zdr ? 0 : retention ? Number(retention) : null,
      region: draft.region,
      noTraining: draft.zdr || draft.noTraining,
    },
    vertex: serviceAccount ? { project: draft.vertex.project, location: draft.vertex.location } : undefined,
    internal: isSignInKind(spec.kind) ? undefined : draft.internal,
  };
}
