import type { TemplateOption } from "@/types/model-templates";

export type KeyOptions = {
  teams: { id: string; alias: string }[];
  projects: { id: string; alias: string; teamId: string | null }[];
  models: string[];
  templates: TemplateOption[];
};
