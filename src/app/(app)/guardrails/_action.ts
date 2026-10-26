"use server";

import { runAction } from "@/lib/http/action-result";
import { testPiiModel } from "@/lib/models/feature-model-test";
import {
  loadGuardrails,
  removePolicyOverride,
  saveGuardrailPolicy,
  savePii,
  savePolicyOverride,
  testPolicies,
} from "@/lib/settings/guardrail-policies";

export async function loadGuardrailsAction(...args: Parameters<typeof loadGuardrails>) {
  return runAction(() => loadGuardrails(...args));
}

export async function savePiiAction(...args: Parameters<typeof savePii>) {
  return runAction(() => savePii(...args));
}

export async function saveGuardrailPolicyAction(...args: Parameters<typeof saveGuardrailPolicy>) {
  return runAction(() => saveGuardrailPolicy(...args));
}

export async function savePolicyOverrideAction(...args: Parameters<typeof savePolicyOverride>) {
  return runAction(() => savePolicyOverride(...args));
}

export async function removePolicyOverrideAction(...args: Parameters<typeof removePolicyOverride>) {
  return runAction(() => removePolicyOverride(...args));
}

export async function testPoliciesAction(...args: Parameters<typeof testPolicies>) {
  return runAction(() => testPolicies(...args));
}

export async function testPiiModelAction(...args: Parameters<typeof testPiiModel>) {
  return runAction(() => testPiiModel(...args));
}
