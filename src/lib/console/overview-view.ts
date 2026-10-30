import type { DeploymentHealthView } from "@/types/provider-health";
import type { OverviewAttention, OverviewStep, OverviewStepId } from "@/types/console";

export const BUDGET_WARN_RATIO = 0.8;
export const ATTENTION_LIMIT = 6;
const FAILING_ERROR_RATE = 0.5;
const FAILING_MIN_ATTEMPTS = 3;

export const STEP_ORDER: readonly OverviewStepId[] = ["provider", "model", "company", "key", "request"];

export function capRatio(spend: number, cap: number): number | null {
  return cap > 0 ? spend / cap : null;
}

export function nearCap(ratio: number | null): ratio is number {
  return ratio !== null && ratio >= BUDGET_WARN_RATIO;
}

export function failingProviders(
  deployments: readonly DeploymentHealthView[],
  now: number,
): { name: string; failures: number; cooling: boolean }[] {
  const byProvider = new Map<string, { name: string; failures: number; cooling: boolean }>();
  for (const row of deployments) {
    const cooling = row.cooldownUntil !== null && row.cooldownUntil > now;
    const failing = row.attempts >= FAILING_MIN_ATTEMPTS && row.errorRate >= FAILING_ERROR_RATE;
    if (!cooling && !failing) continue;
    const name = row.provider || row.alias;
    const current = byProvider.get(name) ?? { name, failures: 0, cooling: false };
    byProvider.set(name, { name, failures: current.failures + row.failures, cooling: current.cooling || cooling });
  }
  return [...byProvider.values()].sort((a, b) => Number(b.cooling) - Number(a.cooling) || b.failures - a.failures);
}

function urgency(item: OverviewAttention): number {
  if (item.kind === "budget") return item.ratio >= 1 ? 0 : 3;
  if (item.kind === "provider") return item.cooling ? 1 : 2;
  return 4;
}

export function rankAttention(items: readonly OverviewAttention[]): OverviewAttention[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => urgency(a.item) - urgency(b.item) || a.index - b.index)
    .slice(0, ATTENTION_LIMIT)
    .map(({ item }) => item);
}

export function orderSteps(steps: readonly OverviewStep[]): OverviewStep[] {
  return STEP_ORDER.flatMap((id) => steps.filter((step) => step.id === id));
}

export function nextStep(steps: readonly OverviewStep[]): OverviewStep | null {
  return steps.find((step) => !step.done) ?? null;
}
