"use server";

import { runAction } from "@/lib/http/action-result";
import {
  discoverProvider,
  loadProviderLimits,
  loadProviders,
  loadSubscriptionLimits,
} from "@/lib/providers/connections";
import {
  loadAccountRouting,
  loadAntigravityConfig,
  loadAssignmentOptions,
  saveAccountRouting,
  saveAntigravityConfig,
  saveAssignments,
} from "@/lib/providers/account-routing";

export async function loadAccountRoutingAction(...args: Parameters<typeof loadAccountRouting>) {
  return runAction(() => loadAccountRouting(...args));
}

export async function saveAccountRoutingAction(...args: Parameters<typeof saveAccountRouting>) {
  return runAction(() => saveAccountRouting(...args));
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

export async function loadProvidersAction(...args: Parameters<typeof loadProviders>) {
  return runAction(() => loadProviders(...args));
}

export async function loadProviderLimitsAction(...args: Parameters<typeof loadProviderLimits>) {
  return runAction(() => loadProviderLimits(...args));
}

export async function loadSubscriptionLimitsAction(...args: Parameters<typeof loadSubscriptionLimits>) {
  return runAction(() => loadSubscriptionLimits(...args));
}

export async function discoverProviderAction(...args: Parameters<typeof discoverProvider>) {
  return runAction(() => discoverProvider(...args));
}
