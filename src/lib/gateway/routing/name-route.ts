import "server-only";
import prisma from "@/lib/db/prisma";
import { extraNamesOf, nameIndex, namedBody, namedModel } from "@/lib/gateway/catalog/model-names";
import type { JsonMap } from "@/types/gateway";

const NAMES_TTL_MS = 15_000;

type NameCache = {
  at: number;
  generation: number;
  names: ReadonlyMap<string, string>;
  aliases: ReadonlySet<string>;
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
  const aliases = new Set(rows.map((row) => row.alias));
  const enabled = new Set(rows.filter((row) => row.enabled !== false).map((row) => row.alias));
  const names = nameIndex(
    rows.filter((row) => extraNamesOf(row.extraNames).length > 0),
    aliases,
  );
  const loaded = { at, generation, names, aliases: enabled };
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

export async function canonicalModel(model: string): Promise<string> {
  const loaded = await cachedNames();
  return namedModel(model, loaded.names, loaded.aliases);
}

export async function canonicalBody(body: JsonMap): Promise<JsonMap> {
  const loaded = await cachedNames();
  return namedBody(body, loaded.names, loaded.aliases);
}
