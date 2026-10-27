import "server-only";
import prisma from "@/lib/db/prisma";
import { contextIndex, resolveContextWindow } from "@/lib/gateway/routing/context-sources";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { ContextIndex, FactTarget, ModelFacts } from "@/types/routing";

const FACTS_TTL_MS = 60_000;

type FactIndex = {
  at: number;
  known: ReadonlySet<string>;
  models: ReadonlyMap<string, ReadonlyMap<string, ModelFacts>>;
  windows: ContextIndex;
  attached: Map<string, ModelFacts | null>;
};

let current: FactIndex | null = null;
let loading: Promise<FactIndex> | null = null;

export function factsByModel(discovered: unknown): ReadonlyMap<string, ModelFacts> {
  const models = new Map<string, ModelFacts>();
  for (const model of discoveredOf(discovered)) {
    if (!model.serviceTiers && !model.accessPrograms && !model.variants && model.contextLength <= 0) continue;
    const facts: ModelFacts = {};
    if (model.serviceTiers) facts.serviceTiers = model.serviceTiers;
    if (model.accessPrograms) facts.accessPrograms = model.accessPrograms;
    if (model.variants) facts.variants = model.variants;
    if (model.contextLength > 0) {
      facts.contextLength = model.contextLength;
      facts.contextSource = "reported";
    }
    models.set(model.id, facts);
  }
  return models;
}

async function loadIndex(wanted: string[]): Promise<FactIndex> {
  const at = Date.now();
  const [providers, routes] = await Promise.all([
    prisma.providerConnection.findMany({ select: { id: true, name: true, kind: true, discovered: true } }),
    prisma.deployment.findMany({
      where: { providerId: { not: null } },
      select: { groupAlias: true, providerId: true, model: true },
    }),
  ]);
  return {
    at,
    known: new Set([...wanted, ...providers.map((row) => row.id)]),
    models: new Map(providers.map((row) => [row.id, factsByModel(row.discovered)])),
    windows: contextIndex(providers, routes),
    attached: new Map(),
  };
}

function freshFor(index: FactIndex | null, wanted: string[]): FactIndex | null {
  if (!index || index.at + FACTS_TTL_MS <= Date.now()) return null;
  return wanted.every((id) => index.known.has(id)) ? index : null;
}

async function factIndex(wanted: string[]): Promise<FactIndex> {
  const fresh = freshFor(current, wanted);
  if (fresh) return fresh;
  loading ??= loadIndex(wanted)
    .then((index) => {
      current = index;
      return index;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function factsOf(index: FactIndex, providerId: string, model: string): ModelFacts | null {
  const key = `${providerId}\u0000${model}`;
  const known = index.attached.get(key);
  if (known !== undefined) return known;
  const own = index.models.get(providerId)?.get(model);
  const window = own?.contextLength ? null : resolveContextWindow(index.windows, providerId, model);
  const facts = window ? { ...own, contextLength: window.tokens, contextSource: window.source } : (own ?? null);
  index.attached.set(key, facts);
  return facts;
}

export async function attachModelFacts(deployments: FactTarget[]): Promise<void> {
  const providers = [...new Set(deployments.flatMap((dep) => dep.provider_id || []))];
  if (!providers.length) return;
  const index = await factIndex(providers);
  for (const dep of deployments) {
    const facts = dep.provider_id ? factsOf(index, dep.provider_id, dep.model) : null;
    if (facts) dep.facts = facts;
  }
}
