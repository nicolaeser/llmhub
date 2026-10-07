export type DataRegion = "eu" | "us" | "global";

export type ProviderPolicy = {
  id: string;
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
};

export type PolicyGroup = {
  alias: string;
  providerIds: (string | null)[];
  overflowGroup: string;
  fallbackGroups: string[];
};

export type RoutePolicy = ProviderPolicy | null;

export type ModelPolicy = {
  alias: string;
  routes: RoutePolicy[];
};

export type DeploymentRule = {
  providerIds: string[];
  regions: string[];
  zdrOnly: boolean;
  noTrainingOnly: boolean;
  maxRetentionDays: number | null;
};

export type RouteLimits = Record<string, DeploymentRule[]>;

export type ModelAccess = {
  models: string[];
  limits: RouteLimits;
};

export type TemplateRules = {
  models: string[];
  patterns: string[];
  providerIds: string[];
  regions: string[];
  zdrOnly: boolean;
  noTrainingOnly: boolean;
  maxRetentionDays: number | null;
};

export type ModelTemplateView = TemplateRules & {
  id: string;
  name: string;
  description: string;
  keyCount: number;
};

export type TemplateOption = {
  id: string;
  name: string;
  description: string;
  matches: string[];
};

export type TemplateProviderOption = {
  id: string;
  name: string;
  kind: string;
};
