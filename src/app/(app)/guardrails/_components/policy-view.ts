import {
  chainLayers,
  effectivePolicies,
  fullLayer,
  policyChain,
  refKey,
  sectionSummaries,
} from "@/lib/gateway/safety/policy-layers";
import { POLICY_SCOPES } from "@/schemas/guardrails";
import type {
  EffectivePolicies,
  PlatformPolicies,
  PolicyLayer,
  PolicyOverrideView,
  PolicyRef,
  PolicySection,
  PolicyTarget,
  SectionSummary,
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

export type SectionChange = {
  section: PolicySection;
  from: SectionSummary;
  to: SectionSummary;
  source: PolicyRef | null;
};

export function overrideChanges(book: PolicyBook, row: PolicyOverrideView): SectionChange[] {
  const inherited = inheritedFor(book, row.target);
  const before = new Map(sectionSummaries(fullLayer(inherited)).map((summary) => [summary.section, summary]));
  return sectionSummaries(row).flatMap((to) => {
    const from = before.get(to.section);
    return from ? [{ section: to.section, from, to, source: inherited.sources[to.section] }] : [];
  });
}

export function sameSummary(a: SectionSummary, b: SectionSummary): boolean {
  return a.state === b.state && a.count === b.count;
}

export function overrideMatches(row: PolicyOverrideView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.target.alias, ...row.target.path].some((part) => part.toLowerCase().includes(needle));
}
