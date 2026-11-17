import "server-only";
import prisma from "@/lib/db/prisma";
import { anthropicAliasIndex, type AnthropicAliasIndex } from "@/lib/gateway/catalog/anthropic-native";
import { extraNamesOf, nameIndex, namedBody, namedModel } from "@/lib/gateway/catalog/model-names";
import type { JsonMap } from "@/types/gateway";

const NAMES_TTL_MS = 15_000;

type NameCache = {
  at: number;
  generation: number;
  names: ReadonlyMap<string, string>;
  native: AnthropicAliasIndex;
};

type NameState = {
  generation: number;
  loaded: NameCache | null;
  loading: Promise<NameCache> | null;
};

const holder = globalThis as typeof globalThis & { __llmhubModelNames?: NameState };

function state(): NameState {
  holder.__llmhubModelNames ??= { generation: 0, loaded: null, loading: null };
  return holder.__llmhubModelNames;
}

async function loadNames(generation: number): Promise<NameCache> {
  const at = Date.now();
  const rows = await prisma.modelGroup.findMany({ select: { alias: true, enabled: true, extraNames: true } });
  const native = anthropicAliasIndex(rows);
  const names = nameIndex(
    rows.filter((row) => extraNamesOf(row.extraNames).length > 0),
    native.aliases,
  );
  const loaded = { at, generation, names, native };
  const current = state();
  if (current.generation === generation) current.loaded = loaded;
  return loaded;
}

async function cachedNames(): Promise<NameCache> {
  const current = state();
  const loaded = current.loaded;
  if (loaded && loaded.generation === current.generation && loaded.at + NAMES_TTL_MS > Date.now()) return loaded;
  const generation = current.generation;
  const loading = (current.loading ??= loadNames(generation).finally(() => {
    if (state().loading === loading) state().loading = null;
  }));
  return loading;
}

export async function modelNames(): Promise<ReadonlyMap<string, string>> {
  return (await cachedNames()).names;
}

export function forgetModelNames(): void {
  const current = state();
  current.generation += 1;
  current.loaded = null;
  current.loading = null;
}

export async function modelResolver(): Promise<(model: string) => string> {
  const loaded = await cachedNames();
  return (model) => namedModel(model, loaded.names, loaded.native);
}

export async function canonicalModel(model: string): Promise<string> {
  return (await modelResolver())(model);
}

export async function canonicalBody(body: JsonMap): Promise<JsonMap> {
  const loaded = await cachedNames();
  return namedBody(body, loaded.names, loaded.native);
}
