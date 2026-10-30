import type { z } from "zod";
import type { accessWindowSchema } from "@/schemas/keys";
import type { TemplateOption } from "@/types/model-templates";
import type { BudgetDetail } from "@/types/structure";

export type KeyBindingOption = { id: string; alias: string; orgId: string; teamId: string };

export type KeyChoices = {
  models: string[];
  templates: TemplateOption[];
  canTemplates: boolean;
};

export type KeyOptions = KeyChoices & {
  companyId: string;
  orgs: { id: string; alias: string }[];
  teams: { id: string; alias: string; orgId: string }[];
  projects: KeyBindingOption[];
  members: KeyBindingOption[];
};

export type KeyBindingKind = "project" | "member" | "internal";

export type KeyPreset = { kind: Exclude<KeyBindingKind, "internal">; id: string };

export type KeyPlace = { org: string; team: string };

export type KeyEndpoint =
  | "chat"
  | "embeddings"
  | "rerank"
  | "moderations"
  | "images"
  | "audio"
  | "videos"
  | "ocr"
  | "files"
  | "vector_stores"
  | "batches"
  | "systemone"
  | "integrations"
  | "mcp";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type AccessWindow = z.infer<typeof accessWindowSchema>;

export type AccessWindowDraft = AccessWindow & { key: number };

export type VirtualKeyView = {
  token_id: string;
  key?: string;
  key_name: string;
  key_alias: string;
  user_id: string;
  team_id: string;
  org_id: string;
  project_id: string;
  member_id: string;
  models: string[];
  templates: string[];
  max_budget: number;
  spend: number;
  rpm_limit: number;
  tpm_limit: number;
  max_request_cost: number;
  budget_duration: string;
  expires: string;
  allowed_ips: string[];
  allowed_endpoints: KeyEndpoint[];
  access_windows: AccessWindow[];
  access_time_zone: string;
  blocked: boolean;
  paused: boolean;
  paused_until: string;
  log_content: boolean;
  created_at: string;
};

export type IssuedKey = VirtualKeyView & { key: string };

export type KeyDetail = { key: VirtualKeyView; templates: { id: string; name: string }[] };

export type KeyFieldsInput = {
  alias: string;
  projectId: string;
  memberId: string;
  models: string[];
  templateIds: string[];
  rpm: number;
  tpm: number;
  maxRequestCost: number;
  allowedIps: string[];
  allowedEndpoints: KeyEndpoint[];
  accessWindows: AccessWindow[];
  accessTimeZone: string;
  logContent: boolean;
};

export type KeyCreateInput = KeyFieldsInput & { days: number };

export type KeyUpdateInput = KeyFieldsInput & { id: string; blocked: boolean };

export type KeyPauseInput = { id: string; hours: number };

export type KeyTenancy = {
  userId: string;
  memberId: string;
  projectId: string;
  teamId: string;
  orgId: string;
};

export type KeyBindingRow = {
  userId: string | null;
  teamId: string | null;
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
};

export type KeyDraft = {
  alias: string;
  kind: KeyBindingKind;
  projectId: string;
  memberId: string;
  restricted: boolean;
  models: string[];
  templateIds: string[];
  rpm: number;
  tpm: number;
  maxRequestCost: number;
  days: number;
  budget: number;
  budgetPeriod: string;
  ips: string;
  endpoints: KeyEndpoint[];
  windows: AccessWindowDraft[];
  timeZone: string;
  logContent: boolean;
  blocked: boolean;
};

export type KeyAccessSummary = { state: "all" | "none" | "some"; models: string[] };

export type KeyOwner = {
  kind: KeyBindingKind;
  name: string;
  orgId: string;
  orgAlias: string;
  teamAlias: string;
};

export type KeyActivity = {
  spend7d: number;
  requests7d: number;
  errors7d: number;
  lastUsed: string;
};

export type KeyDetailPage = KeyDetail & {
  owner: KeyOwner;
  activity: KeyActivity | null;
  budget: BudgetDetail | null;
  options: KeyOptions;
  selfName: string;
  canManage: boolean;
  canBind: boolean;
  canBudget: boolean;
  canMcp: boolean;
  canSeeUsage: boolean;
  canOpenCompany: boolean;
};

export type KeySection = "basics" | "access" | "limits" | "network" | "schedule" | "content";
