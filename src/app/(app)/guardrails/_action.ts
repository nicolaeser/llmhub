"use server";

import { runAction } from "@/lib/http/action-result";
import { testPiiModel } from "@/lib/models/feature-model-test";
import {
  loadGuardrails,
  saveGuardrailOverride,
  saveGuardrailPolicy,
  savePii,
  savePiiOverride,
  testGuardrails,
  testPii,
} from "@/lib/settings/guardrail-policies";

export async function loadGuardrailsAction(...args: Parameters<typeof loadGuardrails>) {
  return runAction(() => loadGuardrails(...args));
}

export async function savePiiAction(...args: Parameters<typeof savePii>) {
  return runAction(() => savePii(...args));
}

export async function savePiiOverrideAction(...args: Parameters<typeof savePiiOverride>) {
  return runAction(() => savePiiOverride(...args));
}

export async function saveGuardrailPolicyAction(...args: Parameters<typeof saveGuardrailPolicy>) {
  return runAction(() => saveGuardrailPolicy(...args));
}

export async function saveGuardrailOverrideAction(...args: Parameters<typeof saveGuardrailOverride>) {
  return runAction(() => saveGuardrailOverride(...args));
}

export async function testPiiAction(...args: Parameters<typeof testPii>) {
  return runAction(() => testPii(...args));
}

export async function testGuardrailsAction(...args: Parameters<typeof testGuardrails>) {
  return runAction(() => testGuardrails(...args));
}

export async function testPiiModelAction(...args: Parameters<typeof testPiiModel>) {
  return runAction(() => testPiiModel(...args));
}
