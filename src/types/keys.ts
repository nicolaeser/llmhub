import type { z } from "zod";
import type { accessWindowSchema } from "@/schemas/keys";
import type { PiiPolicy } from "@/types/guardrails";
import type { TemplateOption } from "@/types/model-templates";

export type KeyBindingOption = { id: string; alias: string; orgId: string; teamId: string };

export type KeyOptions = {
  companyId: string;
  orgs: { id: string; alias: string }[];
  teams: { id: string; alias: string; orgId: string }[];
  projects: KeyBindingOption[];
  members: KeyBindingOption[];
  models: string[];
  templates: TemplateOption[];
};

export type KeyBindingKind = "project" | "member" | "internal";

export type KeyPreset = { kind: KeyBindingKind; id: string };

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
  pii: PiiPolicy | null;
  log_content: boolean;
  created_at: string;
};

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
