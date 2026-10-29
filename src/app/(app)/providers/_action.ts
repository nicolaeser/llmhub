"use server";

import { runAction } from "@/lib/http/action-result";
import { loadProviderHealth } from "@/lib/gateway/routing/health-report";
import {
  loadAccountRouting,
  loadAntigravityConfig,
  loadAssignmentOptions,
  saveAccountRouting,
  saveAntigravityConfig,
  saveAssignments,
  saveAutoReset,
  saveWindowKickoff,
} from "@/lib/providers/account-routing";
import { importAuthFiles, importSignInFile } from "@/lib/providers/auth-import";
import { importCliProxyAuthFiles, listCliProxyAuthFiles } from "@/lib/providers/cliproxy-import";
import { loadSubscriptionKeyUsage } from "@/lib/providers/key-usage";
import {
  completeSignIn,
  createProvider,
  deleteProvider,
  discoverProvider,
  importProviderModels,
  loadProviderConsole,
  loadProviderLimits,
  loadSubscriptionLimits,
  pollSignIn,
  startSignIn,
  updateProvider,
} from "@/lib/providers/connections";
import { redeemProviderReset } from "@/lib/providers/resets";
import { createSubAddLink, deleteSubAddLink, loadSubAddLinks } from "@/lib/providers/sub-add-links";

export async function loadProvidersAction(...args: Parameters<typeof loadProviderConsole>) {
  return runAction(() => loadProviderConsole(...args));
}

export async function createProviderAction(...args: Parameters<typeof createProvider>) {
  return runAction(() => createProvider(...args));
}

export async function updateProviderAction(...args: Parameters<typeof updateProvider>) {
  return runAction(() => updateProvider(...args));
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

export async function startSignInAction(...args: Parameters<typeof startSignIn>) {
  return runAction(() => startSignIn(...args));
}

export async function pollSignInAction(...args: Parameters<typeof pollSignIn>) {
  return runAction(() => pollSignIn(...args));
}

export async function completeSignInAction(...args: Parameters<typeof completeSignIn>) {
  return runAction(() => completeSignIn(...args));
}

export async function importSignInFileAction(...args: Parameters<typeof importSignInFile>) {
  return runAction(() => importSignInFile(...args));
}

export async function importAuthFilesAction(...args: Parameters<typeof importAuthFiles>) {
  return runAction(() => importAuthFiles(...args));
}

export async function listCliProxyAuthFilesAction(...args: Parameters<typeof listCliProxyAuthFiles>) {
  return runAction(() => listCliProxyAuthFiles(...args));
}

export async function importCliProxyAuthFilesAction(...args: Parameters<typeof importCliProxyAuthFiles>) {
  return runAction(() => importCliProxyAuthFiles(...args));
}

export async function loadProviderLimitsAction(...args: Parameters<typeof loadProviderLimits>) {
  return runAction(() => loadProviderLimits(...args));
}

export async function loadSubscriptionLimitsAction(...args: Parameters<typeof loadSubscriptionLimits>) {
  return runAction(() => loadSubscriptionLimits(...args));
}

export async function loadSubscriptionKeyUsageAction(...args: Parameters<typeof loadSubscriptionKeyUsage>) {
  return runAction(() => loadSubscriptionKeyUsage(...args));
}

export async function loadAccountRoutingAction(...args: Parameters<typeof loadAccountRouting>) {
  return runAction(() => loadAccountRouting(...args));
}

export async function saveAccountRoutingAction(...args: Parameters<typeof saveAccountRouting>) {
  return runAction(() => saveAccountRouting(...args));
}

export async function saveAutoResetAction(...args: Parameters<typeof saveAutoReset>) {
  return runAction(() => saveAutoReset(...args));
}

export async function saveWindowKickoffAction(...args: Parameters<typeof saveWindowKickoff>) {
  return runAction(() => saveWindowKickoff(...args));
}

export async function redeemProviderResetAction(...args: Parameters<typeof redeemProviderReset>) {
  return runAction(() => redeemProviderReset(...args));
}

export async function loadAssignmentOptionsAction(...args: Parameters<typeof loadAssignmentOptions>) {
  return runAction(() => loadAssignmentOptions(...args));
}

export async function saveAssignmentsAction(...args: Parameters<typeof saveAssignments>) {
  return runAction(() => saveAssignments(...args));
}

export async function loadAntigravityConfigAction(...args: Parameters<typeof loadAntigravityConfig>) {
  return runAction(() => loadAntigravityConfig(...args));
}

export async function saveAntigravityConfigAction(...args: Parameters<typeof saveAntigravityConfig>) {
  return runAction(() => saveAntigravityConfig(...args));
}

export async function loadProviderHealthAction(...args: Parameters<typeof loadProviderHealth>) {
  return runAction(() => loadProviderHealth(...args));
}

export async function loadSubAddLinksAction(...args: Parameters<typeof loadSubAddLinks>) {
  return runAction(() => loadSubAddLinks(...args));
}

export async function createSubAddLinkAction(...args: Parameters<typeof createSubAddLink>) {
  return runAction(() => createSubAddLink(...args));
}

export async function deleteSubAddLinkAction(...args: Parameters<typeof deleteSubAddLink>) {
  return runAction(() => deleteSubAddLink(...args));
}
