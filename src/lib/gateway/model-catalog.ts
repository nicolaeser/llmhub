import { RESERVED_ALIASES } from "@/lib/gateway/model-alias";
import type {
  CatalogEntryPlan,
  CatalogGroupInput,
  CatalogPlan,
  CatalogProviderInput,
  CatalogRouteInput,
  CatalogSource,
  CatalogStatus,
  JevCandidate,
  JevTask,
  JevVerdict,
  StoredCatalogEntry,
} from "@/types/model-catalog";

export const NATIVE_VENDORS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
  typesafe: "typesafe",
};

const AGGREGATOR_KINDS = new Set(["openrouter", "openrouter_eu"]);
const VENDOR_SYNONYMS: Readonly<Record<string, string>> = { "x-ai": "xai" };
const SNAPSHOT = /^(.+?)-(\d{4}-\d{2}-\d{2}|\d{8})$/;
const DISPLAY_VENDOR_PREFIX = /^[^:]{1,40}:\s+/;
const MIN_CANDIDATE_SIMILARITY = 0.34;
const MAX_JEV_CANDIDATES = 8;

export const JEV_SUGGEST_CONFIDENCE = 0.5;
export const JEV_AUTO_CONFIDENCE = 0.9;
export const JEV_QUESTION = "same_model";
export const JEV_NONE = "none";

type Item = {
  providerId: string;
  kind: string;
  upstreamId: string;
  name: string;
  vendor: string;
  key: string;
  display: string;
};

type Cluster = {
  id: string;
  vendor: string;
  items: Item[];
  alias: string;
};

type Target = {
  alias: string;
  vendor: string;
  name: string;
  label: string;
  tier: number;
  rank: number;
};

type Decidable = {
  trusted: boolean;
  source: CatalogSource;
  confidence: number;
  disabled: boolean;
};

function entryKey(providerId: string, upstreamId: string): string {
  return `${providerId}\u0000${upstreamId}`;
}

export function catalogEntryKey(entry: { providerId: string; upstreamId: string }): string {
  return entryKey(entry.providerId, entry.upstreamId);
}

export function normalizeVendor(value: string): string {
  const vendor = value.trim().toLowerCase().replace(/^~/, "");
  return VENDOR_SYNONYMS[vendor] ?? vendor;
}

export function trustedKind(kind: string): boolean {
  return kind in NATIVE_VENDORS || AGGREGATOR_KINDS.has(kind);
}

function kindRank(kind: string): number {
  if (kind in NATIVE_VENDORS) return 0;
  if (AGGREGATOR_KINDS.has(kind)) return 1;
  return 2;
}

export function vendorOf(kind: string, upstreamId: string): string {
  const native = NATIVE_VENDORS[kind];
  if (native) return native;
  const slash = upstreamId.indexOf("/");
  return slash > 0 ? normalizeVendor(upstreamId.slice(0, slash)) : "";
}

export function displayNameOf(kind: string, upstreamId: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === upstreamId) return "";
  return AGGREGATOR_KINDS.has(kind) ? trimmed.replace(DISPLAY_VENDOR_PREFIX, "") : trimmed;
}

export function baseName(upstreamId: string): string {
  const id = upstreamId.trim().toLowerCase();
  return id.slice(id.lastIndexOf("/") + 1);
}

export function snapshotNames(ids: string[]): Map<string, string> {
  const names = new Map(ids.map((id) => [id, baseName(id)]));
  const present = new Set(names.values());
  const dated = new Map<string, Set<string>>();
  for (const name of present) {
    const base = SNAPSHOT.exec(name)?.[1];
    if (base) dated.set(base, (dated.get(base) ?? new Set()).add(name));
  }
  const out = new Map<string, string>();
  for (const [id, name] of names) {
    const base = SNAPSHOT.exec(name)?.[1];
    const alone = base !== undefined && !present.has(base) && dated.get(base)?.size === 1;
    out.set(id, alone ? base : name);
  }
  return out;
}

export function matchKey(name: string): string {
  return name.replace(/(\d)\.(?=\d)/g, "$1-");
}

function vendorsCompatible(a: string, b: string): boolean {
  return !a || !b || a === b;
}

function tokens(name: string): Set<string> {
  return new Set(matchKey(name).split(/[^a-z0-9]+/).filter(Boolean));
}

export function nameSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  let shared = 0;
  let family = false;
  for (const token of left) {
    if (!right.has(token)) continue;
    shared += 1;
    if (token.length >= 3 && /[a-z]/.test(token)) family = true;
  }
  if (!family) return 0;
  return shared / (left.size + right.size - shared);
}

export function catalogStatus(entry: { source: CatalogSource; disabled: boolean }): CatalogStatus {
  if (entry.source === "route") return "active";
  return entry.disabled ? "disabled" : "new";
}

export function activationEntries<T extends Decidable>(entries: T[]): T[] {
  const anchored = entries.some((entry) => entry.trusted);
  return entries.filter(
    (entry) =>
      !entry.disabled &&
      entry.source !== "route" &&
      (entry.trusted || entry.source === "manual" || entry.source === "" || !anchored) &&
      (entry.source !== "jev" || entry.confidence >= JEV_AUTO_CONFIDENCE),
  );
}

function itemsOf(providers: CatalogProviderInput[]): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const provider of providers) {
    const names = snapshotNames(provider.models.map((model) => model.id));
    for (const model of provider.models) {
      const key = entryKey(provider.id, model.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = names.get(model.id) ?? baseName(model.id);
      items.push({
        providerId: provider.id,
        kind: provider.kind,
        upstreamId: model.id,
        name,
        vendor: vendorOf(provider.kind, model.id),
        key: matchKey(name),
        display: displayNameOf(provider.kind, model.id, model.name),
      });
    }
  }
  return items;
}

function groupMatch(item: Item, byKey: Map<string, CatalogGroupInput[]>): CatalogGroupInput | undefined {
  const matches = (byKey.get(item.key) ?? []).filter((group) => vendorsCompatible(item.vendor, group.vendor));
  return (
    matches.find((group) => group.alias === item.name) ??
    matches.find((group) => group.vendor === item.vendor) ??
    matches[0]
  );
}

function leadOf(items: Item[]): Item {
  return [...items].sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name),
  )[0]!;
}

function clustersOf(
  items: Item[],
  taken: Set<string>,
  stored: Map<string, StoredCatalogEntry>,
): Cluster[] {
  const byId = new Map<string, Cluster>();
  const add = (id: string, vendor: string, item: Item) => {
    const cluster = byId.get(id) ?? { id, vendor, items: [], alias: "" };
    cluster.items.push(item);
    byId.set(id, cluster);
  };
  for (const item of items) {
    if (item.vendor) add(`${item.vendor}|${item.key}`, item.vendor, item);
  }
  for (const item of items) {
    if (item.vendor) continue;
    const owners = [...byId.values()].filter((cluster) => cluster.vendor && cluster.items[0]?.key === item.key);
    if (owners.length === 1) owners[0]!.items.push(item);
    else add(`|${item.key}`, "", item);
  }
  const ordered = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const cluster of ordered) {
    const counts = new Map<string, number>();
    for (const item of cluster.items) {
      const prior = stored.get(entryKey(item.providerId, item.upstreamId));
      if (!prior?.alias || prior.source === "jev" || prior.source === "manual") continue;
      counts.set(prior.alias, (counts.get(prior.alias) ?? 0) + 1);
    }
    const kept = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([alias]) => alias)
      .find((alias) => !taken.has(alias));
    if (!kept) continue;
    cluster.alias = kept;
    taken.add(kept);
  }
  for (const cluster of ordered) {
    if (cluster.alias) continue;
    const lead = leadOf(cluster.items);
    let alias = lead.name;
    if (taken.has(alias)) alias = `${cluster.vendor || lead.kind}-${lead.name}`;
    const stem = alias;
    let suffix = 2;
    while (taken.has(alias)) alias = `${stem}-${suffix++}`;
    taken.add(alias);
    cluster.alias = alias;
  }
  return ordered;
}

function better(a: Target, b: Target): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier;
  if (a.rank !== b.rank) return a.rank < b.rank;
  return a.alias < b.alias;
}

function candidatesFor(item: Item, own: Target, targets: Target[]): JevCandidate[] {
  return targets
    .filter((target) => target.alias !== own.alias && target.alias !== JEV_NONE && better(target, own))
    .filter((target) => vendorsCompatible(item.vendor, target.vendor))
    .map((target) => ({ target, score: nameSimilarity(item.name, target.name) }))
    .filter((row) => row.score >= MIN_CANDIDATE_SIMILARITY)
    .sort((a, b) => b.score - a.score || a.target.alias.localeCompare(b.target.alias))
    .slice(0, MAX_JEV_CANDIDATES)
    .map(({ target }) => ({ alias: target.alias, label: target.label }));
}

export function planCatalog(input: {
  providers: CatalogProviderInput[];
  groups: CatalogGroupInput[];
  routes: CatalogRouteInput[];
  stored: StoredCatalogEntry[];
}): CatalogPlan {
  const items = itemsOf(input.providers);
  const groups = [...input.groups].sort((a, b) => a.alias.localeCompare(b.alias));
  const groupNames = snapshotNames(groups.map((group) => group.alias));
  const byKey = new Map<string, CatalogGroupInput[]>();
  for (const group of groups) {
    const key = matchKey(groupNames.get(group.alias) ?? group.alias);
    byKey.set(key, [...(byKey.get(key) ?? []), group]);
  }
  const routed = new Map<string, string[]>();
  for (const route of input.routes) {
    const key = entryKey(route.providerId, route.model);
    routed.set(key, [...(routed.get(key) ?? []), route.groupAlias].sort());
  }
  const stored = new Map(input.stored.map((row) => [entryKey(row.providerId, row.upstreamId), row]));
  const matched = new Map(items.map((item) => [item, groupMatch(item, byKey)]));
  const clusters = clustersOf(
    items.filter((item) => !matched.get(item)),
    new Set([...RESERVED_ALIASES, ...groups.map((group) => group.alias)]),
    stored,
  );
  const clusterOf = new Map<Item, Cluster>();
  for (const cluster of clusters) for (const item of cluster.items) clusterOf.set(item, cluster);

  const targets = new Map<string, Target>();
  for (const group of groups) {
    targets.set(group.alias, {
      alias: group.alias,
      vendor: group.vendor,
      name: groupNames.get(group.alias) ?? group.alias,
      label: [group.alias, group.vendor, group.displayName].filter(Boolean).join(" · "),
      tier: 0,
      rank: 0,
    });
  }
  for (const cluster of clusters) {
    const lead = leadOf(cluster.items);
    targets.set(cluster.alias, {
      alias: cluster.alias,
      vendor: cluster.vendor,
      name: lead.name,
      label: [cluster.alias, cluster.vendor, lead.display].filter(Boolean).join(" · "),
      tier: 1,
      rank: kindRank(lead.kind),
    });
  }
  const targetList = [...targets.values()];

  const entries: CatalogEntryPlan[] = [];
  const jev: JevTask[] = [];
  for (const item of items) {
    const key = entryKey(item.providerId, item.upstreamId);
    const prior = stored.get(key);
    const base = {
      providerId: item.providerId,
      upstreamId: item.upstreamId,
      kind: item.kind,
      name: item.display,
      vendor: item.vendor,
      disabled: prior?.disabled ?? false,
      classifiedAt: prior?.classifiedAt ?? null,
      trusted: trustedKind(item.kind),
    };
    const push = (alias: string, source: CatalogSource, confidence: number) =>
      entries.push({
        ...base,
        alias,
        source,
        confidence,
        fresh: !prior || prior.alias !== alias || prior.source === "",
      });
    const routes = routed.get(key);
    if (routes?.length) {
      push(prior && routes.includes(prior.alias) ? prior.alias : routes[0]!, "route", 1);
      continue;
    }
    if (prior?.source === "manual" && prior.alias) {
      push(prior.alias, "manual", 1);
      continue;
    }
    if (prior?.source === "route" && prior.alias && targets.has(prior.alias)) {
      push(prior.alias, "manual", 1);
      continue;
    }
    const group = matched.get(item);
    if (group) {
      push(group.alias, "rule", 1);
      continue;
    }
    const cluster = clusterOf.get(item)!;
    if (new Set(cluster.items.map((member) => member.providerId)).size > 1) {
      push(cluster.alias, "rule", 1);
      continue;
    }
    if (
      prior?.source === "jev" &&
      prior.classifiedAt &&
      prior.alias !== cluster.alias &&
      targets.has(prior.alias) &&
      prior.confidence >= JEV_SUGGEST_CONFIDENCE
    ) {
      push(prior.alias, "jev", prior.confidence);
      continue;
    }
    push(cluster.alias, "", 0);
    if (base.classifiedAt) continue;
    const candidates = candidatesFor(item, targets.get(cluster.alias)!, targetList);
    if (candidates.length) {
      jev.push({
        providerId: item.providerId,
        upstreamId: item.upstreamId,
        kind: item.kind,
        vendor: item.vendor,
        name: item.display,
        candidates,
      });
    }
  }
  return { entries, jev };
}

export function autoRouteEntries(entries: CatalogEntryPlan[], groups: CatalogGroupInput[]): CatalogEntryPlan[] {
  const open = new Set(groups.filter((group) => group.autoRoutes).map((group) => group.alias));
  return entries.filter(
    (entry) =>
      entry.fresh &&
      !entry.disabled &&
      entry.trusted &&
      open.has(entry.alias) &&
      (entry.source === "rule" || (entry.source === "jev" && entry.confidence >= JEV_AUTO_CONFIDENCE)),
  );
}

export function jevRequest(task: JevTask, model: string) {
  const criteria: Record<string, string> = {};
  for (const candidate of task.candidates) criteria[candidate.alias] = candidate.label;
  criteria[JEV_NONE] = "None of these. It is a different model, size, version, snapshot, or variant.";
  return {
    model,
    state: {
      provider_kind: task.kind,
      provider_model_id: task.upstreamId,
      provider_display_name: task.name || task.upstreamId,
      vendor: task.vendor || "unknown",
    },
    questions: {
      [JEV_QUESTION]: {
        type: "choice",
        instructions:
          "Which public model alias serves exactly the same model as the provider model in the state? Different sizes, versions, snapshots, and variants such as free, thinking, online, or quantized builds are different models.",
        criteria,
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function jevVerdict(task: JevTask, json: unknown): JevVerdict | null {
  const answer = record(record(record(json)?.answers)?.[JEV_QUESTION]);
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  if (!choice || choice === JEV_NONE || !task.candidates.some((candidate) => candidate.alias === choice)) {
    return null;
  }
  const probability = record(answer?.probabilities)?.[choice];
  const raw = typeof probability === "number" ? probability : answer?.confidence;
  const confidence = typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return { alias: choice, confidence };
}
