import "server-only";
import { loadStructureAction } from "@/app/(app)/companies/_action";
import { notFound, unwrap } from "@/lib/management/http";
import type { BudgetKind, BudgetView, StructurePayload } from "@/types/structure";

export async function loadStructure(): Promise<StructurePayload> {
  return unwrap(await loadStructureAction());
}

export function byId<T extends { id: string }>(rows: T[], id: string, what: string): T {
  const row = rows.find((item) => item.id === id);
  if (!row) throw notFound(what);
  return row;
}

export function byAlias<T extends { alias: string }>(rows: T[], alias: string, what: string): T {
  const wanted = alias.trim().toLowerCase();
  const row = rows.find((item) => item.alias.toLowerCase() === wanted);
  if (!row) throw notFound(what);
  return row;
}

export function budgetHolders(
  structure: StructurePayload,
): { kind: BudgetKind; id: string; alias: string; budget: BudgetView }[] {
  return [
    ...structure.orgs.map((row) => ({ kind: "org" as const, ...row })),
    ...structure.teams.map((row) => ({ kind: "team" as const, ...row })),
    ...structure.projects.map((row) => ({ kind: "project" as const, ...row })),
    ...structure.members.map((row) => ({ kind: "member" as const, ...row })),
    ...structure.users.map((row) => ({ kind: "user" as const, ...row })),
    ...structure.keys.map((row) => ({ kind: "key" as const, ...row })),
  ];
}

export function budgetHolder(structure: StructurePayload, kind: BudgetKind, id: string) {
  const holder = budgetHolders(structure).find((row) => row.kind === kind && row.id === id);
  if (!holder) throw notFound(kind);
  return holder;
}
