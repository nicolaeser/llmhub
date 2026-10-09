import "server-only";
import prisma from "@/lib/db/prisma";
import { REPORTED_COST_KINDS } from "@/lib/gateway/cost";
import { splitTag } from "@/lib/gateway/model-catalog";
import { minuteClock, priceAt, priceWindowQuery, priceWindowRates } from "@/lib/gateway/price-schedule";
import { routePool } from "@/lib/gateway/route-pool";
import { money } from "@/lib/utils/money";
import type { CostRates, ModelPricing, PriceSchedule, PublicModel, TokenPricing } from "@/types/gateway";

const pricedGroupSelect = {
  alias: true,
  vendor: true,
  displayName: true,
  billingMode: true,
  priceInput: true,
  priceOutput: true,
  priceTimeZone: true,
  priceWindows: priceWindowQuery,
  deployments: { select: { kind: true, costInput: true, costOutput: true, provider: { select: { kind: true } } } },
} as const;

function perToken(per1k: number): string {
  return (per1k / 1000).toFixed(13).replace(/\.?0+$/, "") || "0";
}

function tokenPricing(rates: CostRates): TokenPricing {
  return { prompt: perToken(rates.cost_input_per_1k), completion: perToken(rates.cost_output_per_1k) };
}

export function modelPricing(
  group: { billing_mode: string; schedule: PriceSchedule; deployments: (CostRates & { kind: string })[] },
  at: Date,
): ModelPricing | null {
  if (group.billing_mode === "custom") {
    const current = tokenPricing(priceAt(group.schedule, at));
    if (!group.schedule.windows.length) return current;
    return {
      ...current,
      schedule: {
        time_zone: group.schedule.time_zone,
        default: tokenPricing(group.schedule.price),
        windows: group.schedule.windows.map((window) => ({
          start: minuteClock(window.start_minute),
          end: minuteClock(window.end_minute),
          ...tokenPricing(window),
        })),
      },
    };
  }
  const [first] = group.deployments;
  if (!first || group.deployments.some((dep) => REPORTED_COST_KINDS.has(dep.kind))) return null;
  const uniform = group.deployments.every(
    (dep) =>
      dep.cost_input_per_1k === first.cost_input_per_1k &&
      dep.cost_output_per_1k === first.cost_output_per_1k,
  );
  if (!uniform || (first.cost_input_per_1k === 0 && first.cost_output_per_1k === 0)) return null;
  return tokenPricing(first);
}

export async function pricedModels(at: Date, aliases?: string[]): Promise<PublicModel[]> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true, ...(aliases ? { alias: { in: aliases } } : {}) },
    orderBy: { alias: "asc" },
    select: pricedGroupSelect,
  });
  return groups.map((group) => ({
    alias: group.alias,
    vendor: group.vendor,
    displayName: group.displayName,
    tags: [splitTag(group.alias).tag].filter(Boolean),
    pools: [...new Set(group.deployments.map(routePool))],
    pricing: modelPricing(
      {
        billing_mode: group.billingMode,
        schedule: {
          price: { cost_input_per_1k: money(group.priceInput), cost_output_per_1k: money(group.priceOutput) },
          time_zone: group.priceTimeZone,
          windows: group.priceWindows.map(priceWindowRates),
        },
        deployments: group.deployments.map((dep) => ({
          kind: dep.kind,
          cost_input_per_1k: money(dep.costInput),
          cost_output_per_1k: money(dep.costOutput),
        })),
      },
      at,
    ),
  }));
}
