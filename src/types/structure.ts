import type { SpendHolder } from "@/types/gateway";

export type BudgetKind = "org" | "team" | "project" | "user" | "key";

export type NodeKind = "org" | "team" | "project";

export type NodeRef = { kind: NodeKind; id: string };

export type SetupStep = "org" | "team" | "project" | "members" | "budget";

export type BoostView = { id: string; amount: number; until: string };

export type BudgetView = {
  maxBudget: number;
  spend: number;
  budgetDuration: string;
  boost: number;
  boosts: BoostView[];
  resetsAt: string | null;
  projectedMonth: number;
  daysToExhaust: number | null;
  pctUsed: number | null;
};

export type CapLink = {
  kind: BudgetKind;
  id: string;
  alias: string;
  cap: number;
  boost: number;
  spend: number;
};

export type OrgNode = { id: string; alias: string; budget: BudgetView };

export type TeamNode = {
  id: string;
  alias: string;
  orgId: string;
  rpmLimit: number;
  tpmLimit: number;
  budget: BudgetView;
};

export type ProjectNode = {
  id: string;
  alias: string;
  teamId: string;
  owner: string;
  budget: BudgetView;
};

export type MemberNode = {
  id: string;
  username: string;
  email: string;
  orgId: string;
  teamId: string;
  blocked: boolean;
  budget: BudgetView;
};

export type KeyNode = {
  id: string;
  alias: string;
  prefix: string;
  userId: string;
  teamId: string;
  projectId: string;
  blocked: boolean;
  budget: BudgetView;
};

export type StructurePayload = {
  orgs: OrgNode[];
  teams: TeamNode[];
  projects: ProjectNode[];
  users: MemberNode[];
  keys: KeyNode[];
  thresholds: number[];
  canManage: boolean;
  canBudget: boolean;
};

export type BudgetTarget = { kind: BudgetKind; id: string; alias: string };

export type BudgetInput = {
  kind: BudgetKind;
  id: string;
  maxBudget: number;
  budgetDuration: string;
};

export type BoostInput = {
  kind: BudgetKind;
  id: string;
  amount: number;
  hours: number;
};

export type BudgetResult = { kind: BudgetKind; id: string; budget: BudgetView };

export type HolderRecord = {
  alias: string;
  row: SpendHolder;
  userId: string | null;
  projectId: string | null;
  teamId: string | null;
  orgId: string | null;
};
