import { patternMatches } from "@/lib/gateway/model-policy";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { MarkupRule, MarkupScope, MarkupTarget } from "@/types/pricing";

export const MARKUP_SCOPES = ["all", "org", "team", "project"] as const satisfies readonly MarkupScope[];

export const MIN_MARKUP_PERCENT = -100;

export const MAX_MARKUP_PERCENT = 1000;

const SCOPE_RANK: Record<MarkupScope, number> = { all: 0, org: 1, team: 2, project: 3 };

const EXACT_MODEL_RANK = Number.MAX_SAFE_INTEGER;

type MarkupColumns = { orgId: string | null; teamId: string | null; projectId: string | null };

export function markupModel(value: string): string {
  return value.trim().toLowerCase();
}

export function isModelPattern(model: string): boolean {
  return model.includes("*");
}

export function markupScopeRank(scope: MarkupScope): number {
  return SCOPE_RANK[scope];
}

export function markupScopeOf(row: MarkupColumns): { scope: MarkupScope; targetId: string } {
  if (row.projectId) return { scope: "project", targetId: row.projectId };
  if (row.teamId) return { scope: "team", targetId: row.teamId };
  if (row.orgId) return { scope: "org", targetId: row.orgId };
  return { scope: "all", targetId: "" };
}

export function markupColumns(scope: MarkupScope, targetId: string): MarkupColumns {
  return {
    orgId: scope === "org" ? targetId : null,
    teamId: scope === "team" ? targetId : null,
    projectId: scope === "project" ? targetId : null,
  };
}

export function markupRuleOf(
  row: MarkupColumns & { id: string; model: string; percent: Prisma.Decimal | number },
): MarkupRule {
  return { id: row.id, ...markupScopeOf(row), model: row.model, percent: money(row.percent) };
}

function scopeMatches(rule: MarkupRule, target: MarkupTarget): boolean {
  if (rule.scope === "all") return true;
  if (!rule.targetId) return false;
  if (rule.scope === "org") return rule.targetId === target.orgId;
  if (rule.scope === "team") return rule.targetId === target.teamId;
  return rule.targetId === target.projectId;
}

function modelRank(pattern: string, model: string): number {
  if (!pattern) return 0;
  if (!isModelPattern(pattern)) return pattern === markupModel(model) ? EXACT_MODEL_RANK : -1;
  return patternMatches(pattern, model) ? 1 + pattern.replaceAll("*", "").length : -1;
}

export function pickMarkup<T extends MarkupRule>(rules: readonly T[], target: MarkupTarget): T | null {
  let best: T | null = null;
  let bestScope = -1;
  let bestModel = -1;
  for (const rule of rules) {
    if (!scopeMatches(rule, target)) continue;
    const modelScore = modelRank(rule.model, target.model);
    if (modelScore < 0) continue;
    const scopeScore = SCOPE_RANK[rule.scope];
    if (scopeScore > bestScope || (scopeScore === bestScope && modelScore > bestModel)) {
      best = rule;
      bestScope = scopeScore;
      bestModel = modelScore;
    }
  }
  return best;
}

export function applyMarkup(amount: number, percent: number): number {
  return Math.max(0, amount + (amount * percent) / 100);
}

export function marginShare(purchase: number, sale: number): number | null {
  return sale > 0 ? (sale - purchase) / sale : null;
}
