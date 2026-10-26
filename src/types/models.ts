import type { ModelChoice } from "@/lib/models/model-role";
import type { DiscoveredModel } from "@/types/providers";
import type { PublicPool, RoutePool } from "@/types/routing";

export type DeploymentInput = {
  id?: string;
  kind: string;
  baseUrl: string;
  model: string;
  weight: number;
  costInput: number;
  costOutput: number;
  providerId?: string | null;
};

export type DeploymentDraft = {
  id?: string;
  kind: string;
  baseUrl: string;
  model: string;
  weight: string;
  costInput: string;
  costOutput: string;
  providerId: string;
};

export type PriceWindow = {
  start: string;
  end: string;
  priceInput: number;
  priceOutput: number;
};

export type PriceWindowDraft = PriceWindow & { key: number };

export type ModelVariant = "fast" | "ultrafast" | "daybreak";

export type ModelVariantRoute = { variant: ModelVariant; pools: PublicPool[] };

export type ModelGroupView = {
  alias: string;
  enabled: boolean;
  vendor: string;
  displayName: string;
  autoRoutes: boolean | null;
  variants: ModelVariant[];
  strategy: string;
  billingMode: string;
  priceInput: number;
  priceOutput: number;
  priceTimeZone: string;
  priceWindows: PriceWindow[];
  overflowGroup: string;
  numRetries: number;
  fallbackGroups: string[];
  endpoints: number;
  deployments: {
    id: string;
    kind: string;
    baseUrl: string;
    model: string;
    weight: number;
    costInput: number;
    costOutput: number;
    providerId: string | null;
  }[];
};

export type DiscoveredPrice = Pick<DiscoveredModel, "id" | "costInputPer1k" | "costOutputPer1k" | "priceSource">;

export type ContextWindowView = { tokens: number; from?: string };

export type ContextRange = {
  range: "none" | "single" | "span";
  min: number;
  max: number;
  borrowed: "none" | "some" | "all";
};

export type ProviderOpt = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  internal: boolean;
  discovered?: DiscoveredPrice[];
  contextWindows?: Record<string, ContextWindowView>;
};

export type TokenPricing = {
  prompt: string;
  completion: string;
};

export type ModelPricing = TokenPricing & {
  schedule?: {
    time_zone: string;
    default: TokenPricing;
    windows: (TokenPricing & { start: string; end: string })[];
  };
};

export type PublicModel = {
  alias: string;
  vendor: string;
  displayName: string;
  tags: string[];
  pricing: ModelPricing | null;
  subscriptionPricing?: ModelPricing | null;
  pools: RoutePool[];
  variants: ModelVariantRoute[];
};

export type ContextRoute = { kind: string; model: string; provider: { kind: string; internal: boolean; discovered: unknown } | null };

export type ContextGroup = { alias: string; deployments: ContextRoute[] };

export type ContextWindows = Record<RoutePool, ReadonlyMap<string, number>>;

export type SpeedVariants = Record<RoutePool, ReadonlyMap<string, readonly ModelVariant[]>>;

export type CatalogFacts = { windows: ContextWindows; speeds: SpeedVariants };

export type PooledModelChoice = ModelChoice & { pools: RoutePool[] };

export type FeatureModelChoice = ModelChoice & { internal: boolean };

export type ModelFeature = "mcp_builder" | "catalog" | "cache" | "knowledge" | "pii";

export type FeatureModelRole = "chat" | "jev" | "embedding" | "ocr" | "rerank" | "redaction";

export type FeatureModelTest = {
  model: string;
  ok: boolean;
  latencyMs: number;
  status: number;
  error: string;
};
