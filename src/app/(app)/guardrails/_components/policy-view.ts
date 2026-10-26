import { chainLayers, effectivePolicies, policyChain, refKey } from "@/lib/gateway/safety/policy-layers";
import { POLICY_SCOPES } from "@/schemas/guardrails";
import type {
  EffectivePolicies,
  PlatformPolicies,
  PolicyLayer,
  PolicyOverrideView,
  PolicyRef,
  PolicyTarget,
} from "@/types/guardrails";

export type PolicyBook = {
  platform: PlatformPolicies;
  overrides: PolicyOverrideView[];
  targets: PolicyTarget[];
};

function layers(overrides: readonly PolicyOverrideView[]): Map<string, PolicyLayer> {
  return new Map(overrides.map((row) => [refKey(row.target), row]));
}

export function effectiveFor(book: PolicyBook, target: PolicyTarget): EffectivePolicies {
  const known = layers(book.overrides);
  return effectivePolicies(book.platform, chainLayers(policyChain(target), (ref) => known.get(refKey(ref))));
}

export function inheritedFor(book: PolicyBook, target: PolicyTarget): EffectivePolicies {
  const known = layers(book.overrides);
  return effectivePolicies(book.platform, chainLayers(policyChain(target).slice(1), (ref) => known.get(refKey(ref))));
}

export function findTarget(book: PolicyBook, ref: PolicyRef | null): PolicyTarget | undefined {
  if (!ref) return undefined;
  const key = refKey(ref);
  return book.targets.find((target) => refKey(target) === key) ?? book.overrides.find((row) => refKey(row.target) === key)?.target;
}

export function sortOverrides(rows: readonly PolicyOverrideView[]): PolicyOverrideView[] {
  return [...rows].sort(
    (a, b) =>
      POLICY_SCOPES.indexOf(a.target.scope) - POLICY_SCOPES.indexOf(b.target.scope) ||
      a.target.alias.localeCompare(b.target.alias),
  );
}

export function replaceOverride(
  rows: readonly PolicyOverrideView[],
  ref: PolicyRef,
  next: PolicyOverrideView | null,
): PolicyOverrideView[] {
  const key = refKey(ref);
  return sortOverrides([...rows.filter((row) => refKey(row.target) !== key), ...(next ? [next] : [])]);
}
