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
