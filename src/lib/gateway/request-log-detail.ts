import "server-only";

import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { requestTranscript, responseTranscript } from "@/lib/gateway/log-content";
import { replayDraft } from "@/lib/gateway/log-replay";
import { money } from "@/lib/utils/money";
import type { RequestLog } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";
import type { RequestLogDetail, RequestLogRow } from "@/types/logs";

export async function requestLogLabels(rows: { keyId: string; userId: string; memberId: string }[]) {
  const keyIds = [...new Set(rows.map((row) => row.keyId).filter(Boolean))];
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const memberIds = [...new Set(rows.map((row) => row.memberId).filter(Boolean))];
  const [keys, users, members] = await Promise.all([
    keyIds.length
      ? prisma.virtualKey.findMany({
          where: { id: { in: keyIds } },
          select: { id: true, keyAlias: true, prefix: true },
        })
      : [],
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
      : [],
    memberIds.length
      ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
      : [],
  ]);
  return {
    keys: new Map(keys.map((key) => [key.id, key.keyAlias || key.prefix])),
    users: new Map(users.map((user) => [user.id, user.username])),
    members: new Map(members.map((member) => [member.id, member.name])),
  };
}

export function requestLogRow(
  row: RequestLog & { content: { logId: string } | null },
  names: Awaited<ReturnType<typeof requestLogLabels>>,
): RequestLogRow {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    model: row.model,
    endpoint: row.endpoint,
    stream: row.stream,
    status: row.status,
    outcome: row.outcome,
    latencyMs: row.latencyMs,
    keyId: row.keyId,
    keyLabel: names.keys.get(row.keyId) ?? "",
    userId: row.userId,
    userLabel: names.users.get(row.userId) ?? "",
    memberId: row.memberId,
    memberLabel: names.members.get(row.memberId) ?? "",
    teamId: row.teamId,
    orgId: row.orgId,
    projectId: row.projectId,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cost: money(row.cost),
    piiMode: row.piiMode,
    piiInput: row.piiInput,
    piiOutput: row.piiOutput,
    hasContent: Boolean(row.content),
    contentSkip: row.contentSkip,
  };
}

export async function findRequestLogDetail(
  session: AuthenticatedSession,
  id: string,
): Promise<RequestLogDetail | null> {
  const canViewContent = hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT);
  const row = await prisma.requestLog.findFirst({
    where: { id, ...spendScope(session) },
    include: { content: { select: { logId: true } } },
  });
  if (!row) return null;
  const [names, team, org, project, content] = await Promise.all([
    requestLogLabels([row]),
    row.teamId ? prisma.team.findUnique({ where: { id: row.teamId }, select: { alias: true } }) : null,
    row.orgId ? prisma.organization.findUnique({ where: { id: row.orgId }, select: { alias: true } }) : null,
    row.projectId ? prisma.project.findUnique({ where: { id: row.projectId }, select: { alias: true } }) : null,
    canViewContent && row.content ? prisma.requestLogContent.findUnique({ where: { logId: row.id } }) : null,
  ]);
  return {
    ...requestLogRow(row, names),
    teamLabel: team?.alias ?? "",
    orgLabel: org?.alias ?? "",
    projectLabel: project?.alias ?? "",
    deploymentId: row.deploymentId,
    provider: row.provider,
    upstreamModel: row.upstreamModel,
    tag: row.tag,
    error: row.error,
    canViewContent,
    replayable: Boolean(
      content &&
        hasPerm(session.permissions, PERMISSIONS.PLAYGROUND_USE) &&
        replayDraft(row.endpoint, content.request),
    ),
    content: content
      ? {
          request: content.request,
          response: content.response,
          truncated: content.truncated,
          input: requestTranscript(content.request),
          output: responseTranscript(content.response),
        }
      : null,
  };
}
