import type { Prisma } from "@/generated/prisma/client";
import type { PriceWindowRates } from "@/types/billing";
import type { AssignmentRow } from "@/types/providers";

export type RoutePool = "api" | "subscription";

export type Deployment = {
  id: string;
  kind: string;
  base_url: string;
  model: string;
  weight: number;
  cost_input_per_1k: number;
  cost_output_per_1k: number;
  provider_id: string;
};

export type ModelGroup = {
  alias: string;
  strategy: string;
  billing_mode: string;
  price_input_per_1k: number;
  price_output_per_1k: number;
  price_time_zone: string;
  price_windows: PriceWindowRates[];
  overflow_group: string;
  num_retries: number;
  fallback_groups: string[];
  deployments: Deployment[];
};

export type ResolvedModelGroup = ModelGroup & { mapped: ResolvedDeployment[] };

export type DeploymentRow = {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  weight: number;
  costInput: Prisma.Decimal;
  costOutput: Prisma.Decimal;
  providerId: string | null;
  provider: {
    id: string;
    kind: string;
    baseUrl: string;
    apiKey: string;
    zdr: boolean;
    retentionDays: number | null;
    region: string;
    noTraining: boolean;
    enabled: boolean;
    restricted: boolean;
    assignments: AssignmentRow[];
  } | null;
};

export type ResolvedDeployment = Deployment & {
  provider?: DeploymentRow["provider"];
};

export type WeightedChoice = { id: string; weight: number };

export type QuotaScores = Map<string, { pressure: number; reset: number }>;
