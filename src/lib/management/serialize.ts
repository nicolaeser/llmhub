import { chargebackParts } from "@/lib/gateway/usage-stats";
import type { SliceRow, VirtualKeyView } from "@/types/gateway";
import type { RequestLogRow } from "@/types/logs";
import type { AuditLogSource, ProviderSource, SpendLogSource, UsageSource } from "@/types/management";
import type { Group } from "@/types/models";
import type {
  BudgetKind,
  BudgetView,
  MemberNode,
  OrgNode,
  ProjectNode,
  StructurePayload,
  TeamNode,
} from "@/types/structure";

function orNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

function parsedJson(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function serializeApiKey(key: VirtualKeyView) {
  return {
    object: "api_key",
    id: key.token_id,
    alias: key.key_alias,
    prefix: key.key_name,
    user_id: orNull(key.user_id),
    team_id: orNull(key.team_id),
    org_id: orNull(key.org_id),
    project_id: orNull(key.project_id),
    member_id: orNull(key.member_id),
    models: key.models,
    template_ids: key.templates,
    log_content: key.log_content,
    max_budget: key.max_budget,
    spend: key.spend,
    budget_duration: orNull(key.budget_duration),
    rpm_limit: key.rpm_limit,
    tpm_limit: key.tpm_limit,
    allowed_ips: key.allowed_ips,
    blocked: key.blocked,
    expires_at: orNull(key.expires),
    created_at: key.created_at,
    ...(key.key ? { key: key.key } : {}),
  };
}

export function serializeModelAlias(group: Group) {
  return {
    object: "model_alias",
    alias: group.alias,
    enabled: group.enabled,
    vendor: orNull(group.vendor),
    display_name: orNull(group.displayName),
    auto_routes: group.autoRoutes,
    strategy: group.strategy,
    billing_mode: group.billingMode,
    price_input_per_1k: group.priceInput,
    price_output_per_1k: group.priceOutput,
    price_time_zone: group.priceTimeZone,
    price_schedule: group.priceWindows.map((window) => ({
      start: window.start,
      end: window.end,
      price_input_per_1k: window.priceInput,
      price_output_per_1k: window.priceOutput,
    })),
    num_retries: group.numRetries,
    overflow_group: orNull(group.overflowGroup),
    fallback_groups: group.fallbackGroups,
    deployments: group.deployments.map((dep) => ({
      id: dep.id,
      kind: dep.kind,
      base_url: orNull(dep.baseUrl),
      model: dep.model,
      weight: dep.weight,
      cost_input_per_1k: dep.costInput,
      cost_output_per_1k: dep.costOutput,
      provider_id: orNull(dep.providerId),
    })),
  };
}

export function serializeProvider(provider: ProviderSource) {
  return {
    object: "provider",
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    base_url: orNull(provider.baseUrl),
    has_api_key: provider.hasApiKey,
    models: provider.discovered.map((model) => ({
      id: model.id,
      name: model.name,
      owned_by: orNull(model.ownedBy),
      context_length: model.contextLength,
      cost_input_per_1k: model.costInputPer1k,
      cost_output_per_1k: model.costOutputPer1k,
      price_source: model.priceSource,
    })),
  };
}

export function serializeTeam(team: TeamNode, structure: StructurePayload) {
  return {
    object: "team",
    id: team.id,
    alias: team.alias,
    org_id: orNull(team.orgId),
    org_alias: orNull(structure.orgs.find((org) => org.id === team.orgId)?.alias),
    max_budget: team.budget.maxBudget,
    spend: team.budget.spend,
    rpm_limit: team.rpmLimit,
    tpm_limit: team.tpmLimit,
    member_count: structure.members.filter((row) => row.teamId === team.id).length,
  };
}

export function serializeOrg(org: OrgNode, structure: StructurePayload) {
  return {
    object: "organization",
    id: org.id,
    alias: org.alias,
    max_budget: org.budget.maxBudget,
    spend: org.budget.spend,
    team_count: structure.teams.filter((row) => row.orgId === org.id).length,
    project_count: structure.projects.filter((row) => row.orgId === org.id).length,
    member_count: structure.members.filter((row) => row.orgId === org.id).length,
  };
}

export function serializeProject(project: ProjectNode, structure: StructurePayload) {
  return {
    object: "project",
    id: project.id,
    alias: project.alias,
    org_id: orNull(project.orgId),
    org_alias: orNull(structure.orgs.find((org) => org.id === project.orgId)?.alias),
    team_id: orNull(project.teamId),
    team_alias: orNull(structure.teams.find((team) => team.id === project.teamId)?.alias),
    owner: orNull(project.owner),
    max_budget: project.budget.maxBudget,
    spend: project.budget.spend,
  };
}

export function serializeMember(row: MemberNode, structure: StructurePayload) {
  return {
    object: "member",
    id: row.id,
    name: row.alias,
    email: orNull(row.email),
    org_id: row.orgId,
    org_alias: orNull(structure.orgs.find((org) => org.id === row.orgId)?.alias),
    team_id: orNull(row.teamId),
    team_alias: orNull(structure.teams.find((team) => team.id === row.teamId)?.alias),
    blocked: row.blocked,
    log_content: row.logContent,
    max_budget: row.budget.maxBudget,
    spend: row.budget.spend,
  };
}

export function serializeBudget(kind: BudgetKind, holder: { id: string; alias: string; budget: BudgetView }) {
  const { budget } = holder;
  return {
    object: "budget",
    entity_type: kind,
    entity_id: holder.id,
    alias: holder.alias,
    spend: budget.spend,
    max_budget: budget.maxBudget,
    budget_duration: orNull(budget.budgetDuration),
    resets_at: budget.resetsAt,
    temporary_amount: budget.boost,
    temporary_budgets: budget.boosts.map((boost) => ({
      id: boost.id,
      amount: boost.amount,
      expires_at: boost.until,
    })),
    projected_month: budget.projectedMonth,
    days_to_exhaust: budget.daysToExhaust,
    pct_used: budget.pctUsed,
  };
}

function slice(row: SliceRow) {
  return {
    name: row.name,
    spend: row.spend,
    prompt_tokens: row.prompt,
    completion_tokens: row.completion,
    requests: row.requests ?? 0,
    errors: row.errors ?? 0,
    rate_limited: row.rate429 ?? 0,
  };
}

export function serializeUsage(usage: UsageSource) {
  return {
    object: "usage",
    days: usage.days,
    filters: {
      model: orNull(usage.model),
      team_id: orNull(usage.teamId),
      org_id: orNull(usage.orgId),
      project_id: orNull(usage.projectId),
      member_id: orNull(usage.memberId),
      key_id: orNull(usage.keyId),
      user_id: orNull(usage.userId),
    },
    totals: {
      spend: usage.spend,
      tokens: usage.tokens,
      requests: usage.count,
      errors: usage.errors,
      rate_limited: usage.rate429,
      avg_latency_ms: usage.latency,
      p95_latency_ms: usage.p95Latency,
    },
    daily: usage.daily,
    by_model: usage.byModel.map(slice),
    by_team: usage.byTeam.map(slice),
    by_org: usage.byOrg.map(slice),
    by_project: usage.byProject.map(slice),
    by_member: usage.byMember.map(slice),
    by_key: usage.byKey.map(slice),
    by_user: usage.byUser.map(slice),
    chargeback: usage.chargeback.map((row) => {
      const parts = chargebackParts(row.name);
      return {
        org_id: orNull(parts.orgId),
        team_id: orNull(parts.teamId),
        project_id: orNull(parts.projectId),
        member_id: orNull(parts.memberId),
        key_id: orNull(parts.keyId),
        user_id: orNull(parts.userId),
        model: orNull(parts.model),
        spend: row.spend,
        prompt_tokens: row.prompt,
        completion_tokens: row.completion,
      };
    }),
  };
}

export function serializeRequestLog(row: RequestLogRow) {
  return {
    object: "request_log",
    id: row.id,
    created_at: row.createdAt,
    endpoint: row.endpoint,
    model: row.model,
    stream: row.stream,
    status: row.status,
    outcome: row.outcome,
    latency_ms: row.latencyMs,
    key_id: orNull(row.keyId),
    user_id: orNull(row.userId),
    member_id: orNull(row.memberId),
    team_id: orNull(row.teamId),
    org_id: orNull(row.orgId),
    project_id: orNull(row.projectId),
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    cost: row.cost,
    pii_input: row.piiInput,
    pii_output: row.piiOutput,
    guardrail_input: row.guardInput,
    guardrail_output: row.guardOutput,
    has_content: row.hasContent,
  };
}

export function serializeSpendLog(row: SpendLogSource) {
  return {
    object: "spend_log",
    id: row.id,
    created_at: row.createdAt,
    model: row.model,
    spend: row.spend,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
  };
}

export function serializeAuditLog(row: AuditLogSource) {
  return {
    object: "audit_log",
    id: row.id,
    created_at: row.createdAt,
    actor: row.actor,
    action: row.action,
    object_type: row.objectType,
    object_id: row.objectId,
    before: parsedJson(row.before),
    after: parsedJson(row.after),
  };
}
