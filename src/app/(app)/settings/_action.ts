"use server";

import { runAction } from "@/lib/http/action-result";
import { loadCompanyMcpServers, saveCompanyMcpInstallation } from "@/lib/mcp/servers";
import { loadSettingsScope } from "@/lib/settings/scope";
import { loadCache, loadCacheStats, saveCache } from "@/lib/settings/caching";
import { loadCatalogSettings, saveCatalogSettings } from "@/lib/settings/catalog";
import { loadGeneralSettings, saveGeneralSettings } from "@/lib/settings/general";
import { loadLogging, saveLogging } from "@/lib/settings/logging-alerts";
import {
  checkOidcIssuer,
  issueScimToken,
  loadSignInSettings,
  revokeScimToken,
  saveSignInSettings,
} from "@/lib/settings/sign-in";
import { loadStorageSettings, saveStorageSettings, testStorageSettings } from "@/lib/settings/storage";

export async function loadGeneralSettingsAction() {
  return runAction(() => loadGeneralSettings());
}

export async function saveGeneralSettingsAction(...args: Parameters<typeof saveGeneralSettings>) {
  return runAction(() => saveGeneralSettings(...args));
}

export async function loadSignInSettingsAction() {
  return runAction(() => loadSignInSettings());
}

export async function saveSignInSettingsAction(...args: Parameters<typeof saveSignInSettings>) {
  return runAction(() => saveSignInSettings(...args));
}

export async function checkOidcIssuerAction(...args: Parameters<typeof checkOidcIssuer>) {
  return runAction(() => checkOidcIssuer(...args));
}

export async function issueScimTokenAction(...args: Parameters<typeof issueScimToken>) {
  return runAction(() => issueScimToken(...args));
}

export async function revokeScimTokenAction(...args: Parameters<typeof revokeScimToken>) {
  return runAction(() => revokeScimToken(...args));
}

export async function loadStorageSettingsAction() {
  return runAction(() => loadStorageSettings());
}

export async function saveStorageSettingsAction(...args: Parameters<typeof saveStorageSettings>) {
  return runAction(() => saveStorageSettings(...args));
}

export async function testStorageSettingsAction(...args: Parameters<typeof testStorageSettings>) {
  return runAction(() => testStorageSettings(...args));
}

export async function loadLoggingAction() {
  return runAction(() => loadLogging());
}

export async function saveLoggingAction(...args: Parameters<typeof saveLogging>) {
  return runAction(() => saveLogging(...args));
}

export async function loadCacheAction() {
  return runAction(() => loadCache());
}

export async function loadCacheStatsAction(...args: Parameters<typeof loadCacheStats>) {
  return runAction(() => loadCacheStats(...args));
}

export async function saveCacheAction(...args: Parameters<typeof saveCache>) {
  return runAction(() => saveCache(...args));
}

export async function loadCatalogSettingsAction() {
  return runAction(() => loadCatalogSettings());
}

export async function saveCatalogSettingsAction(...args: Parameters<typeof saveCatalogSettings>) {
  return runAction(() => saveCatalogSettings(...args));
}

export async function loadSettingsScopeAction() {
  return runAction(() => loadSettingsScope());
}

export async function loadCompanyMcpSettingsAction(...args: Parameters<typeof loadCompanyMcpServers>) {
  return runAction(() => loadCompanyMcpServers(...args));
}

export async function saveCompanyMcpSettingsAction(...args: Parameters<typeof saveCompanyMcpInstallation>) {
  return runAction(() => saveCompanyMcpInstallation(...args));
}
