"use server";

import { runAction } from "@/lib/http/action-result";
import {
  createTemplate,
  deleteTemplate,
  loadTemplates,
  updateTemplate,
} from "@/lib/models/templates";

export async function loadTemplatesAction(...args: Parameters<typeof loadTemplates>) {
  return runAction(() => loadTemplates(...args));
}

export async function createTemplateAction(...args: Parameters<typeof createTemplate>) {
  return runAction(() => createTemplate(...args));
}

export async function updateTemplateAction(...args: Parameters<typeof updateTemplate>) {
  return runAction(() => updateTemplate(...args));
}

export async function deleteTemplateAction(...args: Parameters<typeof deleteTemplate>) {
  return runAction(() => deleteTemplate(...args));
}
