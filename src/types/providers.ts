export type ProviderRecord = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  discovered: unknown;
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
};

export type ProviderPolicyInput = {
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
};

export type ProviderSyncRecord = ProviderRecord & { updatedAt: Date };

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  discovered: { id: string; name: string }[];
  policy: ProviderPolicyInput;
};
