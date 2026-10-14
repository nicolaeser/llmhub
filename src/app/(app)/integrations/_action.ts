"use server";

import { runAction } from "@/lib/http/action-result";
import {
  addManualEndpoint,
  askIntegrationAgent,
  beginOauth,
  checkConnection,
  clientCredentials,
  completeOauth,
  createCompanyDraft,
  decideApproval,
  deprecateTool,
  explainTool,
  importIntegration,
  instantiateBlueprint,
  loadIntegrationPage,
  previewAccess,
  publishTool,
  requestToolApproval,
  revokeCredential,
  rollbackTool,
  saveAgent,
  saveBinding,
  saveConnection,
  saveIntegrationTool,
  savePolicy,
  setBlueprintVisibility,
  setEndpointSelection,
  testPublishedTool,
  validateTool,
} from "@/lib/integrations/service";

export async function loadIntegrationsAction() {
  return runAction(() => loadIntegrationPage());
}

export async function importIntegrationAction(input: unknown) {
  return runAction(() => importIntegration(input));
}

export async function setBlueprintVisibilityAction(input: unknown) {
  return runAction(() => setBlueprintVisibility(input));
}

export async function createCompanyDraftAction(input: unknown) {
  return runAction(() => createCompanyDraft(input));
}

export async function instantiateBlueprintAction(input: unknown) {
  return runAction(() => instantiateBlueprint(input));
}

export async function addManualEndpointAction(input: unknown) {
  return runAction(() => addManualEndpoint(input));
}

export async function setEndpointSelectionAction(input: unknown) {
  return runAction(() => setEndpointSelection(input));
}

export async function saveIntegrationToolAction(input: unknown) {
  return runAction(() => saveIntegrationTool(input));
}

export async function validateToolAction(input: unknown) {
  return runAction(() => validateTool(input));
}

export async function requestToolApprovalAction(input: unknown) {
  return runAction(() => requestToolApproval(input));
}

export async function decideApprovalAction(input: unknown) {
  return runAction(() => decideApproval(input));
}

export async function publishToolAction(input: unknown) {
  return runAction(() => publishTool(input));
}

export async function deprecateToolAction(input: unknown) {
  return runAction(() => deprecateTool(input));
}

export async function rollbackToolAction(input: unknown) {
  return runAction(() => rollbackTool(input));
}

export async function saveConnectionAction(input: unknown) {
  return runAction(() => saveConnection(input));
}

export async function beginOauthAction(connectionId: string) {
  return runAction(() => beginOauth(connectionId));
}

export async function completeOauthAction(input: unknown) {
  return runAction(() => completeOauth(input));
}

export async function checkConnectionAction(connectionId: string) {
  return runAction(() => checkConnection(connectionId));
}

export async function revokeCredentialAction(connectionId: string) {
  return runAction(() => revokeCredential(connectionId));
}

export async function clientCredentialsAction(connectionId: string) {
  return runAction(() => clientCredentials(connectionId));
}

export async function savePolicyAction(input: unknown) {
  return runAction(() => savePolicy(input));
}

export async function saveAgentAction(input: unknown) {
  return runAction(() => saveAgent(input));
}

export async function saveBindingAction(input: unknown) {
  return runAction(() => saveBinding(input));
}

export async function previewAccessAction(agentId: string, toolId: string) {
  return runAction(() => previewAccess(agentId, toolId));
}

export async function askIntegrationAgentAction(input: unknown) {
  return runAction(() => askIntegrationAgent(input));
}

export async function explainToolAction(toolId: string) {
  return runAction(() => explainTool(toolId));
}

export async function testPublishedToolAction(input: unknown) {
  return runAction(() => testPublishedTool(input));
}
