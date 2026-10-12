import type { DiscoveredModel } from "@/types/providers";
import type { RoutePool } from "@/types/routing";

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

export type ModelGroupView = {
  alias: string;
  enabled: boolean;
  vendor: string;
  displayName: string;
  autoRoutes: boolean | null;
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

export type ProviderOpt = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  discovered?: DiscoveredPrice[];
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
};
