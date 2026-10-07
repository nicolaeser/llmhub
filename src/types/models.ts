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

export type PriceWindowDraft = {
  key: number;
  start: string;
  end: string;
  priceInput: number;
  priceOutput: number;
};

export type Group = {
  alias: string;
  enabled: boolean;
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

export type DiscoveredPrice = {
  id: string;
  costInputPer1k: number;
  costOutputPer1k: number;
  priceSource: string;
};

export type ProviderOpt = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  discovered?: DiscoveredPrice[];
};
