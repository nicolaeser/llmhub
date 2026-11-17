import { anthropicCatalogAlias, EMPTY_ANTHROPIC_INDEX, type AnthropicAliasIndex } from "@/lib/gateway/catalog/anthropic-native";
import { isReservedAlias, modelAlias, plainModel } from "@/lib/gateway/catalog/model-alias";
import type { JsonMap } from "@/types/gateway";

export const MAX_EXTRA_NAMES = 20;
export const EXTRA_NAME_MAX = 120;

export function extraNamesOf(value: unknown): string[] {
  const list: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const names = list.flatMap((item) => (typeof item === "string" ? [modelAlias(item)] : []));
  return [...new Set(names.filter(Boolean))];
}

export function extraNameProblem(name: string): "reserved" | "too_long" | null {
  if (isReservedAlias(name)) return "reserved";
  if (name.length > EXTRA_NAME_MAX) return "too_long";
  return null;
}

export function nameIndex(
  groups: readonly { alias: string; extraNames?: unknown }[],
  aliases: ReadonlySet<string>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of [...groups].sort((a, b) => a.alias.localeCompare(b.alias))) {
    for (const name of extraNamesOf(group.extraNames)) {
      if (name === group.alias || aliases.has(name) || index.has(name) || isReservedAlias(name)) continue;
      index.set(name, group.alias);
    }
  }
  return index;
}

export function namedModel(
  model: string,
  names: ReadonlyMap<string, string>,
  native: AnthropicAliasIndex = EMPTY_ANTHROPIC_INDEX,
): string {
  if (!names.size && !native.aliases.size) return model;
  const requested = model.trim();
  const plain = plainModel(requested);
  const alias = names.get(modelAlias(plain)) ?? anthropicCatalogAlias(plain, native);
  return alias ? `${requested.slice(0, requested.length - plain.length)}${alias}` : model;
}

function namedChain(value: unknown, names: ReadonlyMap<string, string>, native: AnthropicAliasIndex): unknown {
  if (typeof value === "string") return namedModel(value, names, native);
  if (Array.isArray(value)) return value.map((item) => namedChain(item, names, native));
  if (value && typeof value === "object" && typeof (value as JsonMap).model === "string") {
    return { ...(value as JsonMap), model: namedModel(String((value as JsonMap).model), names, native) };
  }
  return value;
}

export function namedBody(
  body: JsonMap,
  names: ReadonlyMap<string, string>,
  native: AnthropicAliasIndex = EMPTY_ANTHROPIC_INDEX,
): JsonMap {
  if (!names.size && !native.aliases.size) return body;
  const named: JsonMap = { ...body };
  if (typeof body.model === "string") named.model = namedModel(body.model, names, native);
  if ("fallbacks" in body) named.fallbacks = namedChain(body.fallbacks, names, native);
  if ("fallback" in body) named.fallback = namedChain(body.fallback, names, native);
  return named;
}
