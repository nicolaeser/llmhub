"use server";

import { runAction } from "@/lib/http/action-result";
import {
  completeSignIn,
  createProvider,
  deleteProvider,
  discoverProvider,
  importProviderModels,
  loadProviderLimits,
  loadProviders,
  loadSubscriptionLimits,
  pollSignIn,
  startSignIn,
  updateProvider,
} from "@/lib/providers/connections";

export async function loadProvidersAction(...args: Parameters<typeof loadProviders>) {
  return runAction(() => loadProviders(...args));
}

export async function createProviderAction(...args: Parameters<typeof createProvider>) {
  return runAction(() => createProvider(...args));
}

export async function updateProviderAction(...args: Parameters<typeof updateProvider>) {
  return runAction(() => updateProvider(...args));
}

export async function loadProviderLimitsAction(...args: Parameters<typeof loadProviderLimits>) {
  return runAction(() => loadProviderLimits(...args));
}

export async function loadSubscriptionLimitsAction(...args: Parameters<typeof loadSubscriptionLimits>) {
  return runAction(() => loadSubscriptionLimits(...args));
}

export async function startSignInAction(...args: Parameters<typeof startSignIn>) {
  return runAction(() => startSignIn(...args));
}

export async function pollSignInAction(...args: Parameters<typeof pollSignIn>) {
  return runAction(() => pollSignIn(...args));
}

export async function completeSignInAction(...args: Parameters<typeof completeSignIn>) {
  return runAction(() => completeSignIn(...args));
}

export async function deleteProviderAction(...args: Parameters<typeof deleteProvider>) {
  return runAction(() => deleteProvider(...args));
}

export async function discoverProviderAction(...args: Parameters<typeof discoverProvider>) {
  return runAction(() => discoverProvider(...args));
}

export async function importProviderModelsAction(...args: Parameters<typeof importProviderModels>) {
  return runAction(() => importProviderModels(...args));
}
