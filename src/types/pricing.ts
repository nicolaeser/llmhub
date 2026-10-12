import type { loadMarkupsAction } from "@/app/(app)/markups/_action";

export type MarkupScope = "all" | "org" | "team" | "project";

export type MarkupTenancy = {
  orgId: string;
  teamId: string;
  projectId: string;
};

export type MarkupTarget = MarkupTenancy & {
  model: string;
};

export type MarkupRule = {
  id: string;
  scope: MarkupScope;
  targetId: string;
  model: string;
  percent: number;
};

export type MarkupView = MarkupRule & {
  note: string;
  updatedAt: string;
};

export type MarginTotals = {
  purchase: number;
  sale: number;
};

export type MarkupOrgOption = { id: string; alias: string };

export type MarkupTeamOption = { id: string; alias: string; orgId: string };

export type MarkupProjectOption = { id: string; alias: string; orgId: string; teamId: string };

export type MarkupsPayload = Exclude<Awaited<ReturnType<typeof loadMarkupsAction>>, { ok: false }>;

export type MarkupKind = "markup" | "discount";

export type MarkupModelMode = "all" | "one" | "pattern";

export type MarginGroup = "orgId" | "teamId" | "projectId" | "model";

export type MarginRow = { id: string; purchase: number; sale: number };
