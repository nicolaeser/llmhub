import type { AttributeFilter, AttributeValue, Attributes, ComparisonFilter } from "@/types/rag";

function ordered(left: AttributeValue, right: AttributeValue): number | null {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return null;
}

function compare(attributes: Attributes, filter: ComparisonFilter): boolean {
  const present = Object.hasOwn(attributes, filter.key);
  const actual = attributes[filter.key];
  const expected = filter.value;
  if (filter.type === "in" || filter.type === "nin") {
    const list = Array.isArray(expected) ? expected : [expected];
    const found = present && list.some((value) => value === actual);
    return filter.type === "in" ? found : !found;
  }
  if (Array.isArray(expected)) return false;
  if (filter.type === "eq") return present && actual === expected;
  if (filter.type === "ne") return !present || actual !== expected;
  if (!present || actual === undefined) return false;
  const diff = ordered(actual, expected);
  if (diff === null) return false;
  if (filter.type === "gt") return diff > 0;
  if (filter.type === "gte") return diff >= 0;
  if (filter.type === "lt") return diff < 0;
  return diff <= 0;
}

export function matchesFilter(attributes: Attributes, filter: AttributeFilter | null | undefined): boolean {
  if (!filter) return true;
  if ("filters" in filter) {
    return filter.type === "and"
      ? filter.filters.every((inner) => matchesFilter(attributes, inner))
      : filter.filters.some((inner) => matchesFilter(attributes, inner));
  }
  return compare(attributes, filter);
}

export function attributesOf(value: unknown): Attributes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Attributes = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      out[key] = item;
    }
  }
  return out;
}
