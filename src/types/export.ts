import type { SliceRow, UsageSummary } from "@/types/usage";

export type UsagePdfStats = UsageSummary & {
  p95Latency: number;
  byModel: SliceRow[];
  chargeback: SliceRow[];
};
