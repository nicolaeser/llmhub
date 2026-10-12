"use server";

import { runAction } from "@/lib/http/action-result";
import {
  createModelGroup,
  deleteModelGroup,
  loadModels,
  setModelGroupEnabled,
  updateModelGroup,
} from "@/lib/models/groups";

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
