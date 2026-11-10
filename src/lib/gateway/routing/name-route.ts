import "server-only";
import prisma from "@/lib/db/prisma";
import { extraNamesOf, nameIndex, namedBody, namedModel } from "@/lib/gateway/catalog/model-names";
import type { JsonMap } from "@/types/gateway";

const NAMES_TTL_MS = 15_000;

type NameState = {
  generation: number;
  loaded: { at: number; generation: number; names: ReadonlyMap<string, string> } | null;
  loading: Promise<ReadonlyMap<string, string>> | null;
};

const holder = globalThis as typeof globalThis & { __llmhubModelNames?: NameState };

function state(): NameState {
  holder.__llmhubModelNames ??= { generation: 0, loaded: null, loading: null };
  return holder.__llmhubModelNames;
}

async function loadNames(generation: number): Promise<ReadonlyMap<string, string>> {
  const at = Date.now();
  const groups = await prisma.modelGroup.findMany({
    where: { extraNames: { isEmpty: false } },
    select: { alias: true, extraNames: true },
  });
  const wanted = [...new Set(groups.flatMap((group) => extraNamesOf(group.extraNames)))];
  const taken = wanted.length
    ? await prisma.modelGroup.findMany({ where: { alias: { in: wanted } }, select: { alias: true } })
    : [];
  const names = nameIndex(groups, new Set(taken.map((row) => row.alias)));
  const current = state();
  if (current.generation === generation) current.loaded = { at, generation, names };
  return names;
}

export async function modelNames(): Promise<ReadonlyMap<string, string>> {
  const current = state();
  const loaded = current.loaded;
  if (loaded && loaded.generation === current.generation && loaded.at + NAMES_TTL_MS > Date.now()) {
    return loaded.names;
  }
  const generation = current.generation;
  const loading = (current.loading ??= loadNames(generation).finally(() => {
    if (state().loading === loading) state().loading = null;
  }));
  return loading;
}

export function forgetModelNames(): void {
  const current = state();
  current.generation += 1;
  current.loaded = null;
  current.loading = null;
}

export async function canonicalModel(model: string): Promise<string> {
  return namedModel(model, await modelNames());
}

export async function canonicalBody(body: JsonMap): Promise<JsonMap> {
  return namedBody(body, await modelNames());
}
