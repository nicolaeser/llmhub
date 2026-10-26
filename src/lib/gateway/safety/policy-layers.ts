import { POLICY_SECTIONS } from "@/schemas/guardrails";
import type {
  EffectivePolicies,
  PlatformPolicies,
  PolicyLayer,
  PolicyRef,
  PolicyScope,
  PolicySection,
  PolicyTarget,
  SectionSummary,
} from "@/types/guardrails";

export const INHERIT_ALL: PolicyLayer = { pii: null, injection: null, secrets: null, rules: null };

const SPECIFICITY: Record<PolicyScope, number> = { key: 0, project: 1, team: 2, org: 3 };

export type SourcedLayer = PolicyLayer & { ref: PolicyRef };

export function sameRef(a: PolicyRef, b: PolicyRef): boolean {
  return a.scope === b.scope && a.id === b.id;
}

export function refKey(ref: PolicyRef): string {
  return `${ref.scope}:${ref.id}`;
}

export function policyChain(target: Pick<PolicyTarget, "scope" | "id" | "orgId" | "teamId" | "projectId">): PolicyRef[] {
  const parents: PolicyRef[] = [
    { scope: "project", id: target.projectId },
    { scope: "team", id: target.teamId },
    { scope: "org", id: target.orgId },
  ];
  return [
    { scope: target.scope, id: target.id },
    ...parents.filter((ref) => ref.id && SPECIFICITY[ref.scope] > SPECIFICITY[target.scope]),
  ];
}

export function isInheritAll(layer: PolicyLayer): boolean {
  return POLICY_SECTIONS.every((section) => layer[section] === null);
}

export function customSections(layer: PolicyLayer): PolicySection[] {
  return POLICY_SECTIONS.filter((section) => layer[section] !== null);
}

export function effectivePolicies(platform: PlatformPolicies, layers: readonly SourcedLayer[]): EffectivePolicies {
  const owner = (section: PolicySection) => layers.find((layer) => layer[section] !== null);
  const pii = owner("pii");
  const injection = owner("injection");
  const secrets = owner("secrets");
  const rules = owner("rules");
  return {
    pii: pii?.pii ?? platform.pii,
    guardrails: {
      injection: injection?.injection ?? platform.guardrails.injection,
      secrets: secrets?.secrets ?? platform.guardrails.secrets,
      rules: rules?.rules ?? platform.guardrails.rules,
    },
    sources: {
      pii: pii?.ref ?? null,
      injection: injection?.ref ?? null,
      secrets: secrets?.ref ?? null,
      rules: rules?.ref ?? null,
    },
  };
}

export function chainLayers(chain: readonly PolicyRef[], layerOf: (ref: PolicyRef) => PolicyLayer | undefined): SourcedLayer[] {
  return chain.flatMap((ref) => {
    const layer = layerOf(ref);
    return layer ? [{ ...layer, ref }] : [];
  });
}

export function fullLayer(policies: PlatformPolicies): PolicyLayer {
  return {
    pii: policies.pii,
    injection: policies.guardrails.injection,
    secrets: policies.guardrails.secrets,
    rules: policies.guardrails.rules,
  };
}

export function sectionSummaries(layer: PolicyLayer): SectionSummary[] {
  const rows: SectionSummary[] = [];
  if (layer.pii) {
    rows.push({ section: "pii", state: layer.pii.enabled ? layer.pii.mode : "off", count: layer.pii.entities.length });
  }
  if (layer.injection) {
    rows.push({
      section: "injection",
      state: layer.injection.enabled ? layer.injection.action : "off",
      count: layer.injection.checks.length,
    });
  }
  if (layer.secrets) {
    rows.push({
      section: "secrets",
      state: layer.secrets.enabled ? layer.secrets.action : "off",
      count: layer.secrets.entities.length,
    });
  }
  if (layer.rules) {
    rows.push({ section: "rules", state: layer.rules.length ? "on" : "off", count: layer.rules.length });
  }
  return rows;
}
