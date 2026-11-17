import { isReservedAlias, modelAlias } from "@/lib/gateway/catalog/model-alias";

export type AnthropicAliasIndex = {
  aliases: ReadonlySet<string>;
  enabled: ReadonlySet<string>;
  owners: ReadonlyMap<string, string | null>;
};

const CLAUDE_CODE_GATEWAY_IDS: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-opus-4-1": "claude-opus-4-1-20250805",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
};

const CLAUDE_CODE_RELEASE_IDS: Readonly<Record<string, string>> = {
  "claude-opus-4-0": "claude-opus-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
};

export const EMPTY_ANTHROPIC_INDEX: AnthropicAliasIndex = { aliases: new Set(), enabled: new Set(), owners: new Map() };

function anthropicParts(model: string): { base: string; snapshot: string } | null {
  const id = model.trim().toLowerCase();
  const start = id.lastIndexOf("claude-");
  if (start < 0) return null;
  const core = id
    .slice(start)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/@(\d{8})(?=$|[@:-])/, "-$1")
    .replace(/[@:].*$/, "")
    .replace(/-v\d+$/, "");
  const snapshot = /-(\d{8})$/.exec(core)?.[1] ?? "";
  return { base: core.replace(/-\d{8}$/, "").replace(/\./g, "-"), snapshot };
}

export function anthropicBaseModel(model: string): string {
  return anthropicParts(model)?.base ?? "";
}

function releaseParts(model: string): { base: string; snapshot: string } | null {
  const parts = anthropicParts(model);
  if (!parts) return null;
  return { base: CLAUDE_CODE_RELEASE_IDS[parts.base] ?? parts.base, snapshot: parts.snapshot };
}

export function anthropicAliasIndex(rows: readonly { alias: string; enabled: boolean }[]): AnthropicAliasIndex {
  const owners = new Map<string, string | null>();
  for (const row of rows) {
    const base = releaseParts(row.alias)?.base;
    if (base) owners.set(base, owners.has(base) ? null : row.alias);
  }
  return {
    aliases: new Set(rows.map((row) => row.alias)),
    enabled: new Set(rows.filter((row) => row.enabled).map((row) => row.alias)),
    owners,
  };
}

function sameSnapshot(base: string, requested: string, owned: string): boolean {
  if (!requested || !owned) return !requested || CLAUDE_CODE_GATEWAY_IDS[base] === `${base}-${requested}`;
  return requested === owned;
}

export function anthropicCatalogAlias(model: string, index: AnthropicAliasIndex): string | undefined {
  const plain = modelAlias(model);
  if (index.aliases.has(plain)) return undefined;
  const unbracketed = plain.replace(/\[[^\]]*\]/g, "");
  if (unbracketed !== plain && index.aliases.has(unbracketed)) {
    return index.enabled.has(unbracketed) ? unbracketed : undefined;
  }
  const requested = releaseParts(unbracketed);
  if (!requested) return undefined;
  const owner = index.aliases.has(requested.base) ? requested.base : index.owners.get(requested.base);
  if (!owner || !index.enabled.has(owner)) return undefined;
  const owned = releaseParts(owner);
  if (!owned || !sameSnapshot(requested.base, requested.snapshot, owned.snapshot)) return undefined;
  return owner;
}

export function anthropicPublicIds(alias: string): string[] {
  const base = releaseParts(modelAlias(alias))?.base;
  if (!base) return [];
  const ids = [CLAUDE_CODE_GATEWAY_IDS[base], base].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].filter((id) => id !== alias && !isReservedAlias(id));
}
