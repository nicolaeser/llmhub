import "server-only";
import { markupPercent } from "@/lib/gateway/billing/billing";
import { releaseHolds, reserveBudget } from "@/lib/gateway/billing/budget-hold";
import { estimateCost } from "@/lib/gateway/billing/cost-cap";
import { applyMarkup } from "@/lib/gateway/billing/markup-policy";
import {
  grantedOutput,
  limitOutput,
  outputWanted,
  requestChoices,
  restoreOutput,
} from "@/lib/gateway/billing/output-fit";
import { promptLength, tokensForLength } from "@/lib/gateway/billing/tokens";
import { plainModel } from "@/lib/gateway/catalog/model-alias";
import { GateError } from "@/lib/gateway/errors";
import { logger } from "@/lib/logging/logger";
import type { HoldOutcome, HoldPlan, HoldSizing } from "@/types/billing";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

function amount(value: number): string {
  return value.toFixed(6);
}

function requestedModel(plan: HoldPlan, group: ResolvedModelGroup): string {
  return plainModel(typeof plan.body.model === "string" && plan.body.model ? plan.body.model : group.alias);
}

async function holdSizing(
  plan: HoldPlan,
  dep: ResolvedDeployment,
  group: ResolvedModelGroup,
  at: Date,
): Promise<HoldSizing> {
  const { body, principal } = plan;
  const { perChoice, floorPerChoice } = outputWanted(body);
  const choices = requestChoices(body);
  const prompt = tokensForLength(promptLength(body));
  const price = (completion: number) => estimateCost(dep, group, body, { prompt, completion: completion * choices }, at);
  const wanted = price(perChoice);
  if (!(wanted > 0)) return { base: 0, wanted: 0, minimum: 0, perChoice, floorPerChoice };
  const percent = await markupPercent({
    orgId: principal.orgId,
    teamId: principal.teamId,
    projectId: principal.key?.project_id ?? "",
    model: requestedModel(plan, group),
  });
  const marked = (value: number) => (percent ? applyMarkup(value, percent) : value);
  return { base: marked(price(0)), wanted: marked(wanted), minimum: marked(price(floorPerChoice)), perChoice, floorPerChoice };
}

function holdRejection(outcome: Extract<HoldOutcome, { granted: false }>, minimum: number): GateError {
  const holder = outcome.binding ?? "budget";
  if (!(outcome.available > 0)) return new GateError(429, "budget_exceeded", `${holder} budget exceeded`);
  return new GateError(
    429,
    "budget_exceeded",
    `the ${holder} budget has ${amount(outcome.available)} left after running requests, less than the ${amount(minimum)} this request needs`,
  );
}

export async function holdRequestBudget(
  plan: HoldPlan,
  dep: ResolvedDeployment,
  group: ResolvedModelGroup,
  now = new Date(),
): Promise<void> {
  const trace = plan.principal.trace;
  if (!trace) return;
  restoreOutput(plan.body, plan.output);
  const release = plan.holds.splice(0);
  const sizing = await holdSizing(plan, dep, group, now);
  if (!(sizing.wanted > 0)) {
    await releaseHolds(release);
    trace.holds = (trace.holds ?? []).filter((id) => !release.includes(id));
    return;
  }
  const outcome = await reserveBudget(
    { ceilings: plan.ceilings, wanted: sizing.wanted, minimum: sizing.minimum, release },
    now,
  );
  trace.holds = (trace.holds ?? []).filter((id) => !release.includes(id));
  if (!outcome.granted) throw holdRejection(outcome, sizing.minimum);
  if (outcome.holdId) {
    plan.holds.push(outcome.holdId);
    trace.holds.push(outcome.holdId);
  }
  const perChoice = grantedOutput(outcome.amount, sizing.base, sizing.wanted, sizing.perChoice);
  if (perChoice >= sizing.perChoice) return;
  const limited = Math.max(sizing.floorPerChoice, perChoice);
  limitOutput(plan.body, limited, dep.kind);
  logger.info("gateway.output_limited", {
    keyId: plan.principal.key?.token_id ?? "",
    model: requestedModel(plan, group),
    requested: sizing.perChoice,
    limited,
  });
}
