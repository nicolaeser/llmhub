"use server";

import { runAction } from "@/lib/http/action-result";
import {
  issueScimToken,
  loadAdminSettings,
  revokeScimToken,
  saveAdminSettings,
} from "@/lib/settings/admin";

export async function loadAdminSettingsAction(...args: Parameters<typeof loadAdminSettings>) {
  return runAction(() => loadAdminSettings(...args));
}

export async function saveAdminSettingsAction(...args: Parameters<typeof saveAdminSettings>) {
  return runAction(() => saveAdminSettings(...args));
}

export async function issueScimTokenAction(...args: Parameters<typeof issueScimToken>) {
  return runAction(() => issueScimToken(...args));
}

export async function revokeScimTokenAction(...args: Parameters<typeof revokeScimToken>) {
  return runAction(() => revokeScimToken(...args));
}
