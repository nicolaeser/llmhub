import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import type { DiscoveredModel, CatalogPrice } from "@/types/gateway";

function anyFloat(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function parsePricing(raw: unknown): { in: number; out: number } | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  let pin = anyFloat(rec.prompt) || anyFloat(rec.input);
  let pout = anyFloat(rec.completion) || anyFloat(rec.output);
  if (pin === 0 && pout === 0) return null;
  if (pin > 0 && pin < 0.01) pin *= 1000;
  if (pout > 0 && pout < 0.01) pout *= 1000;
  return { in: pin, out: pout };
}

export function discoveredOf(v: unknown): DiscoveredModel[] {
  if (!Array.isArray(v)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    out.push({
      id,
      name: asString(rec.name) || asString(rec.display_name) || id,
      ownedBy: asString(rec.ownedBy) || asString(rec.owned_by),
      contextLength: asNumber(rec.contextLength, asNumber(rec.context_length, 0)),
      costInputPer1k: asNumber(
        rec.costInputPer1k,
        asNumber(rec.cost_input_per_1k, 0),
      ),
      costOutputPer1k: asNumber(
        rec.costOutputPer1k,
        asNumber(rec.cost_output_per_1k, 0),
      ),
      priceSource: asString(rec.priceSource) || asString(rec.price_source) || "none",
    });
  }
  return out;
}

export function catalogPricesOf(raw: unknown): CatalogPrice[] {
  return discoveredOf(raw)
    .filter(
      (row) =>
        row.priceSource === "provider" ||
        row.costInputPer1k > 0 ||
        row.costOutputPer1k > 0,
    )
    .map((row) => ({
      id: row.id,
      costInput: row.costInputPer1k,
      costOutput: row.costOutputPer1k,
      priceSource: row.priceSource,
    }));
}

export function priceForUpstream(
  rows: CatalogPrice[],
  model: string,
): CatalogPrice | null {
  const wanted = model.trim();
  if (!wanted) return null;
  const exact = rows.find((row) => row.id === wanted);
  if (exact) return exact;
  const suffix = `/${wanted}`;
  return rows.find((row) => row.id.endsWith(suffix)) ?? null;
}
