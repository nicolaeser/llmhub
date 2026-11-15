"use server";

import { runAction } from "@/lib/http/action-result";
import {
  assignCatalogEntry,
  loadCatalog,
  refreshCatalog,
  setCatalogEntryActive,
  setCatalogGroupActive,
  setCatalogGroupAutoRoutes,
} from "@/lib/models/catalog";
import {
  createModelGroup,
  deleteModelGroup,
  loadModels,
  setModelGroupEnabled,
  updateModelGroup,
} from "@/lib/models/groups";
import { createTemplate, deleteTemplate, loadTemplates, updateTemplate } from "@/lib/models/templates";

export async function loadModelsAction(...args: Parameters<typeof loadModels>) {
  return runAction(() => loadModels(...args));
}

export async function createModelGroupAction(...args: Parameters<typeof createModelGroup>) {
  return runAction(() => createModelGroup(...args));
}

export async function updateModelGroupAction(...args: Parameters<typeof updateModelGroup>) {
  return runAction(() => updateModelGroup(...args));
}

export async function setModelGroupEnabledAction(...args: Parameters<typeof setModelGroupEnabled>) {
  return runAction(() => setModelGroupEnabled(...args));
}

export async function deleteModelGroupAction(...args: Parameters<typeof deleteModelGroup>) {
  return runAction(() => deleteModelGroup(...args));
}

export async function loadCatalogAction(...args: Parameters<typeof loadCatalog>) {
  return runAction(() => loadCatalog(...args));
}

export async function refreshCatalogAction(...args: Parameters<typeof refreshCatalog>) {
  return runAction(() => refreshCatalog(...args));
}

export async function setCatalogGroupActiveAction(...args: Parameters<typeof setCatalogGroupActive>) {
  return runAction(() => setCatalogGroupActive(...args));
}

export async function setCatalogGroupAutoRoutesAction(...args: Parameters<typeof setCatalogGroupAutoRoutes>) {
  return runAction(() => setCatalogGroupAutoRoutes(...args));
}

export async function setCatalogEntryActiveAction(...args: Parameters<typeof setCatalogEntryActive>) {
  return runAction(() => setCatalogEntryActive(...args));
}

export async function assignCatalogEntryAction(...args: Parameters<typeof assignCatalogEntry>) {
  return runAction(() => assignCatalogEntry(...args));
}

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
