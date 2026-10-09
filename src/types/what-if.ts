import type { CostRates, PriceSchedule } from "@/types/gateway";
import type { CatalogGroupState } from "@/types/model-catalog";
import type { MarkupTenancy } from "@/types/pricing";

export type MinuteTokens = {
  minute: number;
  prompt: number;
  completion: number;
};

export type TrafficTotals = {
  requests: number;
  prompt: number;
  completion: number;
  cost: number;
};

export type TenantTraffic = MarkupTenancy & {
  prompt: number;
  completion: number;
};

export type TenantMinutes = MarkupTenancy & {
  minutes: MinuteTokens[];
};

export type WhatIfSource = TrafficTotals & {
  model: string;
};

export type PricedDeployment = CostRates & {
  weight: number;
};

export type TargetPrice = {
  schedule: PriceSchedule;
  floor: CostRates | null;
};

export type WhatIfTargetInput = {
  alias: string;
  vendor: string;
  displayName: string;
  state: CatalogGroupState;
  price: TargetPrice;
};

export type WhatIfTarget = {
  alias: string;
  vendor: string;
  displayName: string;
  state: CatalogGroupState;
  scheduled: boolean;
  cost: number;
};

export type WhatIfView = {
  days: number;
  since: string;
  firstAt: string | null;
  model: string;
  sources: WhatIfSource[];
  traffic: TrafficTotals;
  targets: WhatIfTarget[];
};

export type WhatIfDirection = "saved" | "more" | "same" | "unbilled";
