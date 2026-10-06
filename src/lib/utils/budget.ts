import type { CapLink } from "@/types/structure";

export const BUDGET_PERIODS = ["", "1d", "7d", "30d"] as const;
export const MAX_BUDGET_AMOUNT = 1_000_000_000;
export const MAX_BOOST_HOURS = 720;

export function budgetPeriod(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  if (raw === "daily" || raw === "1d") return "1d";
  if (raw === "weekly" || raw === "7d") return "7d";
  if (raw === "monthly" || raw === "1mo" || raw === "30d") return "30d";
  const match = /^(\d{1,3})d$/.exec(raw);
  if (!match) return null;
  const days = Number(match[1]);
  return days >= 1 && days <= 366 ? `${days}d` : null;
}

export function budgetAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

export function capConflict(cap: number, ancestors: CapLink[]): CapLink | null {
  if (!(cap > 0)) return null;
  return ancestors.find((link) => link.cap > 0 && cap > link.cap) ?? null;
}

export function headroom(chain: CapLink[]): { amount: number; link: CapLink } | null {
  let best: { amount: number; link: CapLink } | null = null;
  for (const link of chain) {
    if (!(link.cap > 0)) continue;
    const amount = Math.max(0, link.cap + link.boost - link.spend);
    if (!best || amount < best.amount) best = { amount, link };
  }
  return best;
}

export function meterColor(ratio: number): "accent" | "warning" | "danger" {
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "warning";
  return "accent";
}
