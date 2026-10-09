import "server-only";

import prisma from "@/lib/db/prisma";
import type { AuthenticatedSession } from "@/types/auth";
import { keyScope } from "@/lib/auth/scope";
import type { VirtualKeyView } from "@/types/gateway";
import { money } from "@/lib/utils/money";
import { piiOverride } from "@/lib/gateway/settings";
import type { Prisma } from "@/generated/prisma/client";

function jsonArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

export function toKeyView(row: {
  id: string;
  prefix: string;
  keyAlias: string;
  userId: string | null;
  teamId: string | null;
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
  models: unknown;
  maxBudget: Prisma.Decimal;
  spend: Prisma.Decimal;
  rpmLimit: number;
  tpmLimit: number;
  maxRequestCost: Prisma.Decimal;
  budgetDuration: string;
  expiresAt: Date | null;
  allowedIps: unknown;
  blocked: boolean;
  piiPolicy: unknown;
  logContent: boolean;
  createdAt: Date;
  templates: { templateId: string }[];
}): VirtualKeyView {
  return {
    token_id: row.id,
    key_name: row.prefix,
    key_alias: row.keyAlias,
    user_id: row.userId ?? "",
    team_id: row.teamId ?? "",
    org_id: row.orgId ?? "",
    project_id: row.projectId ?? "",
    member_id: row.memberId ?? "",
    models: jsonArray(row.models),
    templates: row.templates.map((template) => template.templateId),
    max_budget: money(row.maxBudget),
    spend: money(row.spend),
    rpm_limit: row.rpmLimit,
    tpm_limit: row.tpmLimit,
    max_request_cost: money(row.maxRequestCost),
    budget_duration: row.budgetDuration,
    expires: row.expiresAt?.toISOString() ?? "",
    allowed_ips: jsonArray(row.allowedIps),
    blocked: row.blocked,
    pii: piiOverride(row.piiPolicy),
    log_content: row.logContent,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listKeys(session: AuthenticatedSession) {
  const rows = await prisma.virtualKey.findMany({
    where: keyScope(session),
    orderBy: { createdAt: "desc" },
    include: { templates: { select: { templateId: true } } },
  });
  return rows.map(toKeyView);
}
