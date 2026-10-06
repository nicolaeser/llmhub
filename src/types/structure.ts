import type { SpendHolder } from "@/types/gateway";

export type BudgetKind = "org" | "team" | "project" | "member" | "user" | "key";

export type NodeKind = "org" | "team" | "project" | "member";

export type NodeRef = { kind: NodeKind; id: string };

export type SetupStep = "org" | "team" | "project" | "member" | "budget";

export type SpendScope = { orgId?: string; userId?: string };

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
  orgId: string;
  teamId: string;
  owner: string;
  budget: BudgetView;
};

export type MemberNode = {
  id: string;
  alias: string;
  email: string;
  orgId: string;
  teamId: string;
  blocked: boolean;
  logContent: boolean;
  budget: BudgetView;
};

export type ConsoleUserNode = {
  id: string;
  alias: string;
  orgId: string;
  budget: BudgetView;
};

export type KeyNode = {
  id: string;
  alias: string;
  prefix: string;
  userId: string;
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  blocked: boolean;
  budget: BudgetView;
};

export type StructurePayload = {
  orgs: OrgNode[];
  teams: TeamNode[];
  projects: ProjectNode[];
  members: MemberNode[];
  users: ConsoleUserNode[];
  keys: KeyNode[];
  thresholds: number[];
  companyId: string;
  canManage: boolean;
  canBudget: boolean;
  canCreateKeys: boolean;
};

export type MemberInput = {
  id?: string;
  alias: string;
  email: string;
  orgId: string;
  teamId: string;
  blocked: boolean;
  logContent: boolean;
};

export type ProjectInput = {
  id?: string;
  alias: string;
  orgId: string;
  teamId: string;
  owner: string;
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
  orgId: string | null;
  links: { kind: BudgetKind; id: string | null }[];
};
