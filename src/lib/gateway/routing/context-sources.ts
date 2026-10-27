import {
  baseName,
  matchKey,
  snapshotBase,
  splitTag,
  taggedAlias,
  vendorOf,
  vendorsCompatible,
} from "@/lib/gateway/catalog/model-catalog";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { ContextIndex, ContextWindow, KnownWindow, WindowProvider, WindowRoute } from "@/types/routing";

type Candidate = { tokens: number; from: string };

function routeKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`;
}

export function windowKey(model: string): string {
  const { base, tag } = splitTag(baseName(model));
  return taggedAlias(matchKey(snapshotBase(base)), tag);
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function contextIndex(providers: WindowProvider[], routes: WindowRoute[]): ContextIndex {
  const reported = new Map<string, number>();
  const named = new Map<string, KnownWindow[]>();
  const kinds = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const provider of providers) {
    kinds.set(provider.id, provider.kind);
    labels.set(provider.id, provider.name);
    for (const model of discoveredOf(provider.discovered)) {
      if (!(model.contextLength > 0)) continue;
      reported.set(routeKey(provider.id, model.id), model.contextLength);
      append(named, windowKey(model.id), {
        vendor: vendorOf(provider.kind, model.id),
        tokens: model.contextLength,
        from: provider.name,
      });
    }
  }
  const groups = new Map<string, WindowRoute[]>();
  const memberOf = new Map<string, string[]>();
  for (const route of routes) {
    if (!route.providerId || !route.groupAlias) continue;
    append(groups, route.groupAlias, route);
    const key = routeKey(route.providerId, route.model);
    if (!memberOf.get(key)?.includes(route.groupAlias)) append(memberOf, key, route.groupAlias);
  }
  return { reported, named, kinds, labels, groups, memberOf };
}

function largest(candidates: Candidate[]): Candidate | null {
  return candidates.reduce<Candidate | null>(
    (best, next) =>
      !best || next.tokens > best.tokens || (next.tokens === best.tokens && next.from < best.from) ? next : best,
    null,
  );
}

function groupWindows(index: ContextIndex, providerId: string, model: string): Candidate[] {
  return (index.memberOf.get(routeKey(providerId, model)) ?? []).flatMap((group) =>
    (index.groups.get(group) ?? []).flatMap((peer) => {
      if (!peer.providerId) return [];
      const tokens = index.reported.get(routeKey(peer.providerId, peer.model));
      return tokens ? [{ tokens, from: index.labels.get(peer.providerId) ?? "" }] : [];
    }),
  );
}

export function resolveContextWindow(index: ContextIndex, providerId: string, model: string): ContextWindow | null {
  const own = index.reported.get(routeKey(providerId, model));
  if (own) return { tokens: own, source: "reported" };
  const vendor = vendorOf(index.kinds.get(providerId) ?? "", model);
  const named = (index.named.get(windowKey(model)) ?? []).filter((known) => vendorsCompatible(vendor, known.vendor));
  const best = largest([...named, ...groupWindows(index, providerId, model)]);
  return best ? { tokens: best.tokens, source: "borrowed", from: best.from } : null;
}
