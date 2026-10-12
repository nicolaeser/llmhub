import type { Prisma } from "@/generated/prisma/client";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";
import type { BudgetKind } from "@/types/structure";

export type SpendHolder = {
  id: string;
  spend: Prisma.Decimal;
  maxBudget: Prisma.Decimal;
  budgetDuration: string;
  spendResetAt: Date | null;
  createdAt: Date;
};

export type CostRates = {
  cost_input_per_1k: number;
  cost_output_per_1k: number;
};

export type PriceWindowRates = CostRates & {
  start_minute: number;
  end_minute: number;
};

export type PriceSchedule = {
  price: CostRates;
  time_zone: string;
  windows: PriceWindowRates[];
};

export type BillingGroup = {
  alias: string;
  billing_mode: string;
  price_input_per_1k: number;
  price_output_per_1k: number;
  price_time_zone: string;
  price_windows: PriceWindowRates[];
  deployments: CostRates[];
};

export type BillingContext = {
  mode: string;
  peers: CostRates[];
  price?: CostRates;
};

export type PriceFactors = {
  input: number;
  output: number;
  cacheRead: number;
};

export type CacheTokens = {
  read: number;
  written: number;
  writtenLong: number;
};

type PromptTokenDetails = { cached_tokens: number };

export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
  prompt_tokens_details?: PromptTokenDetails;
  service_tier?: string;
  speed?: string;
  inference_geo?: string;
  cost?: number;
};

export type RequestTokens = {
  prompt: number;
  completion: number;
};

export type CostCap = {
  limit: number;
  budget: BudgetKind | null;
};

export type CostFilter = {
  cap: CostCap;
  estimate: (dep: ResolvedDeployment, group: ResolvedModelGroup) => number;
};
