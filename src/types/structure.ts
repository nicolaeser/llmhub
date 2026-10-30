import type { SpendHolder } from "@/types/billing";
import type { UsageReportView } from "@/types/reports";

export type BudgetKind = "org" | "team" | "project" | "member" | "user" | "key";

export type TenancyKind = "org" | "team" | "project" | "member";

export type NodeKind = TenancyKind | "key";

export type TenancyRef = { kind: TenancyKind; id: string };

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

export type OrgNode = { id: string; alias: string; budget: BudgetView; labelKeys: string[] };

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
  paused: boolean;
  pausedUntil: string;
  budget: BudgetView;
};

export type StructurePayload = {
  platformLabelKeys: string[];
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
  canSeeKeys: boolean;
  canManageKeys: boolean;
  canCreateKeys: boolean;
  canMcp: boolean;
  canSeeMcp: boolean;
  reports: UsageReportView[];
  canSeeReports: boolean;
  canReport: boolean;
  canSeeSettings: boolean;
  canSeeUsers: boolean;
  canSeeUsage: boolean;
  canSeePolicies: boolean;
  mailEnabled: boolean;
};

export type DepartmentGroup = { team: TeamNode | null; projects: ProjectNode[]; members: number };

export type CompanyRow = {
  id: string;
  alias: string;
  budget: BudgetView;
  teams: number;
  projects: number;
  members: number;
  keys: number;
};

export type CompanyDirectory = {
  rows: CompanyRow[];
  canManage: boolean;
  canSeeKeys: boolean;
};

export type CompanyStatus = "exhausted" | "near" | "empty" | "ok";

export type CompanyTab = "overview" | "structure" | "people" | "keys" | "access" | "integrations" | "reports";

export type CompanyLink = { orgId: string; tab: CompanyTab | null; node: TenancyRef | null };

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

export type BudgetRef = { kind: BudgetKind; id: string };

export type BudgetTarget = BudgetRef & { alias: string };

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

export type BudgetDetail = BudgetResult & { ancestors: CapLink[] };

export type HolderRecord = {
  alias: string;
  row: SpendHolder;
  orgId: string | null;
  links: { kind: BudgetKind; id: string | null }[];
};
