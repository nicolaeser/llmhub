import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, spendScope } from "@/lib/auth/scope";
import { failingProviders, capRatio, nearCap, orderSteps, rankAttention } from "@/lib/console/overview-view";
import { loadModelPolicies } from "@/lib/gateway/access/model-access";
import { loadProviderHealth } from "@/lib/gateway/routing/health-report";
import { keyState } from "@/lib/keys/pause";
import { listKeys } from "@/lib/keys/view";
import { budgetRatio, companyHref } from "@/lib/tenancy/company-view";
import { loadCompany, loadCompanyDirectory } from "@/lib/tenancy/structure";
import { usageToday } from "@/lib/usage/usage-today";
import { usageTotals } from "@/lib/usage/usage-totals";
import type { Permission } from "@/types/auth";
import type { OverviewAttention, OverviewPage, OverviewStep, ScopeKind } from "@/types/console";

export type PageAccess = (permissions: readonly Permission[], pathname: string, scope: ScopeKind) => boolean;

const HEALTH_MINUTES = 15;

export async function loadOverview(canOpen: PageAccess): Promise<OverviewPage> {
  const session = await requireActor();
  const company = companyOf(session);
  const scope: ScopeKind = company ? "company" : "platform";
  const can = (permission: Permission) => hasPerm(session.permissions, permission);
  const opens = (pathname: string) => canOpen(session.permissions, pathname, scope);
  const linkTo = (pathname: string, href = pathname) => (opens(pathname) ? href : null);
  if (!opens("/overview")) throw new AuthError("FORBIDDEN");

  const platform = scope === "platform";
  const readsProviders = platform && can(PERMISSIONS.PROVIDERS_READ);
  const readsModels = platform && can(PERMISSIONS.MODELS_READ);
  const readsCompanies = can(PERMISSIONS.TENANCY_READ);
  const readsKeys = can(PERMISSIONS.KEYS_READ);
  const readsSpend = can(PERMISSIONS.SPEND_READ);
  const spend = readsSpend ? spendScope(session) : null;
  const now = Date.now();

  const [providerCount, health, models, directory, ownCompany, keys, today, week, firstRequest] = await Promise.all([
    readsProviders ? prisma.providerConnection.count() : null,
    readsProviders ? loadProviderHealth(HEALTH_MINUTES) : null,
    readsModels ? loadModelPolicies() : null,
    readsCompanies && platform ? loadCompanyDirectory() : null,
    readsCompanies && company ? loadCompany(company) : null,
    readsKeys ? listKeys(session) : null,
    spend ? usageToday(spend, now) : null,
    spend ? usageTotals(7, spend) : null,
    spend ? prisma.usageDaily.findFirst({ where: { ...spend, requests: { gt: 0 } }, select: { day: true } }) : null,
  ]);

  const steps: OverviewStep[] = [];
  if (providerCount !== null) steps.push({ id: "provider", done: providerCount > 0, href: linkTo("/providers") });
  if (models !== null) steps.push({ id: "model", done: models.length > 0, href: linkTo("/models") });
  if (directory !== null) steps.push({ id: "company", done: directory.rows.length > 0, href: linkTo("/companies") });
  if (keys !== null) steps.push({ id: "key", done: keys.length > 0, href: linkTo("/keys") });
  if (spend !== null) {
    steps.push({
      id: "request",
      done: firstRequest !== null,
      href: linkTo("/developer", "/developer?tab=playground") ?? linkTo("/logs"),
    });
  }

  const failing = health ? failingProviders(health.deployments, now) : [];
  const attention: OverviewAttention[] = [];
  for (const row of directory?.rows ?? []) {
    const ratio = budgetRatio(row.budget);
    if (nearCap(ratio)) {
      attention.push({
        kind: "budget",
        id: `company:${row.id}`,
        target: "company",
        name: row.alias,
        ratio,
        href: linkTo("/companies", companyHref({ orgId: row.id, tab: null, node: null }, true)),
      });
    }
  }
  const own = ownCompany?.orgs[0];
  const ownRatio = own ? budgetRatio(own.budget) : null;
  if (own && nearCap(ownRatio)) {
    attention.push({ kind: "budget", id: `company:${own.id}`, target: "company", name: own.alias, ratio: ownRatio, href: linkTo("/companies") });
  }
  for (const key of keys ?? []) {
    const ratio = capRatio(key.spend, key.max_budget);
    if (nearCap(ratio)) {
      attention.push({
        kind: "budget",
        id: `key:${key.token_id}`,
        target: "key",
        name: key.key_alias || key.key_name,
        ratio,
        href: linkTo("/keys", `/keys/${encodeURIComponent(key.token_id)}`),
      });
    }
  }
  for (const provider of failing) {
    attention.push({
      kind: "provider",
      id: `provider:${provider.name}`,
      name: provider.name,
      failures: provider.failures,
      cooling: provider.cooling,
      href: linkTo("/providers", "/providers?tab=health"),
    });
  }
  if (today && today.errors > 0) {
    attention.push({ kind: "errors", id: "errors:today", count: today.errors, href: linkTo("/logs") });
  }

  const nowDate = new Date(now);
  return {
    steps: orderSteps(steps),
    today: today ? { spend: today.spend, requests: today.requests, errors: today.errors } : null,
    week: week ? { spend: week.spend7d, requests: week.requests7d, errors: week.errors7d } : null,
    keys: keys
      ? {
          total: keys.length,
          active: keys.filter(
            (key) =>
              keyState({ blocked: key.blocked, paused: key.paused, pausedUntil: key.paused_until }, nowDate) === "active",
          ).length,
        }
      : null,
    providers: providerCount !== null ? { total: providerCount, online: Math.max(0, providerCount - failing.length) } : null,
    attention: rankAttention(attention),
    concepts: [
      { id: "company", href: linkTo("/companies") },
      { id: "key", href: linkTo("/keys") },
      { id: "preset", href: platform ? linkTo("/models", "/models?tab=presets") : null },
      { id: "guardrail", href: linkTo("/guardrails") },
    ],
  };
}
