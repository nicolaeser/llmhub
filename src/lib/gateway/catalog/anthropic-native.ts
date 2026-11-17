import { isReservedAlias, modelAlias } from "@/lib/gateway/catalog/model-alias";

// Claude Code 2.1.326 calls a dated gateway id for these models. The undated id is the same model.
const GATEWAY_IDS: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-opus-4-1": "claude-opus-4-1-20250805",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
};

// Claude Code's own ids for the original 4.0 releases. The provider id drops the trailing "-0".
const LOGICAL_BASE: Record<string, string> = {
  "claude-opus-4-0": "claude-opus-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
};

export function anthropicBaseModel(model: string): string {
  const id = model.trim().toLowerCase();
  const start = id.lastIndexOf("claude-");
  if (start < 0) return "";
  return id
    .slice(start)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[@:].*$/, "")
    .replace(/-v\d+$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/\./g, "-");
}

function catalogBase(model: string): string {
  const native = anthropicBaseModel(model);
  if (!native) return "";
  return LOGICAL_BASE[native] ?? native;
}

// The catalog alias for a native or dated Anthropic id, when exactly one enabled model is that model.
// A different release (claude-sonnet-5 versus claude-sonnet-5-5) is not a match.
export function anthropicCatalogAlias(model: string, aliases: ReadonlySet<string>): string | undefined {
  const plain = modelAlias(model);
  if (aliases.has(plain)) return undefined;
  const stripped = plain.replace(/\[[^\]]*\]/g, "");
  if (stripped !== plain && aliases.has(stripped)) return stripped;
  const base = catalogBase(stripped);
  if (!base) return undefined;
  if (base !== stripped && aliases.has(base)) return base;
  const owners = [...aliases].filter((alias) => alias !== stripped && catalogBase(alias) === base);
  return owners.length === 1 ? owners[0] : undefined;
}

// Ids Claude Code asks for that are not the catalog alias. Real aliases and reserved names are left out.
export function anthropicPublicIds(alias: string, taken: ReadonlySet<string>): string[] {
  const key = modelAlias(alias);
  const base = catalogBase(key);
  if (!base) return [];
  const ids = [GATEWAY_IDS[base], base].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].filter((id) => id !== key && !taken.has(id) && !isReservedAlias(id));
}
