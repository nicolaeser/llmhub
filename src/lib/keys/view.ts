import "server-only";

import prisma from "@/lib/db/prisma";
import type { AuthenticatedSession } from "@/types/auth";
import { keyScope } from "@/lib/auth/scope";
import type { KeyHolds, KeyLastUse, VirtualKeyView } from "@/types/keys";
import { money } from "@/lib/utils/money";
import { accessTimeZoneOf, accessWindowsOf, allowedEndpointsOf } from "@/lib/gateway/access/key-restrictions";
import { longestPause, pauseView, rowPause } from "@/lib/keys/pause";
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
  allowedEndpoints: unknown;
  accessWindows: unknown;
  accessTimeZone: string;
  blocked: boolean;
  paused: boolean;
  pausedUntil: Date | null;
  logContent: boolean;
  createdAt: Date;
  templates: { templateId: string }[];
}): VirtualKeyView {
  const pause = pauseView(row, new Date());
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
    allowed_endpoints: allowedEndpointsOf(row.allowedEndpoints),
    access_windows: accessWindowsOf(row.accessWindows),
    access_time_zone: accessTimeZoneOf(row.accessTimeZone),
    blocked: row.blocked,
    paused: pause.paused,
    paused_until: pause.pausedUntil,
    log_content: row.logContent,
    created_at: row.createdAt.toISOString(),
  };
}

export function keyReferences(keys: readonly VirtualKeyView[], selfId: string) {
  const ids = (pick: (key: VirtualKeyView) => string) => [...new Set(keys.map(pick).filter(Boolean))];
  return {
    orgs: ids((key) => key.org_id),
    teams: ids((key) => key.team_id),
    projects: ids((key) => key.project_id),
    members: ids((key) => key.member_id),
    users: [...new Set([selfId, ...ids((key) => key.user_id)])],
  };
}

export async function keyHolds(keys: readonly VirtualKeyView[], now = new Date()): Promise<KeyHolds> {
  const refs = keyReferences(keys, "");
  const where = (ids: string[]) => ({
    id: { in: ids },
    paused: true,
    OR: [{ pausedUntil: null }, { pausedUntil: { gt: now } }],
  });
  const select = { id: true, paused: true, pausedUntil: true } as const;
  const [members, projects, teams, orgs] = await Promise.all([
    refs.members.length ? prisma.member.findMany({ where: where(refs.members), select }) : [],
    refs.projects.length ? prisma.project.findMany({ where: where(refs.projects), select }) : [],
    refs.teams.length ? prisma.team.findMany({ where: where(refs.teams), select }) : [],
    refs.orgs.length ? prisma.organization.findMany({ where: where(refs.orgs), select }) : [],
  ]);
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
  const [member, project, team, org] = [byId(members), byId(projects), byId(teams), byId(orgs)];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const pause = longestPause([
        rowPause("member", member.get(key.member_id), now),
        rowPause("project", project.get(key.project_id), now),
        rowPause("team", team.get(key.team_id), now),
        rowPause("org", org.get(key.org_id), now),
      ]);
      return pause ? [[key.token_id, pause]] : [];
    }),
  );
}

function scopedKeyRows(session: AuthenticatedSession) {
  return prisma.virtualKey.findMany({
    where: keyScope(session),
    orderBy: { createdAt: "desc" },
    include: { templates: { select: { templateId: true } } },
  });
}

export async function listKeys(session: AuthenticatedSession) {
  return (await scopedKeyRows(session)).map(toKeyView);
}

export async function listKeysWithLastUse(
  session: AuthenticatedSession,
): Promise<{ keys: VirtualKeyView[]; lastUsed: KeyLastUse }> {
  const rows = await scopedKeyRows(session);
  return {
    keys: rows.map(toKeyView),
    lastUsed: Object.fromEntries(
      rows.flatMap((row) => (row.lastUsedAt ? [[row.id, row.lastUsedAt.toISOString()]] : [])),
    ),
  };
}
