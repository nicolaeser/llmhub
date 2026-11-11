import "server-only";

import prisma from "@/lib/db/prisma";
import { labelRecord, labelsOf } from "@/lib/usage/labels";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { Prisma } from "@/generated/prisma/client";
import type {
  ArchiveDataset,
  ArchiveDayRange,
  ArchiveReadOptions,
  ArchiveRecord,
  ArchiveSource,
} from "@/types/archive";

const PAGE_SIZE = 1_000;
const CONTENT_PAGE_SIZE = 200;

type Cursor = { at: Date; id: string };

function span(range: ArchiveDayRange) {
  return { gte: range.from, lt: range.to };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function jsonOrText(value: string): unknown {
  if (!value) return null;
  return parseJsonOrNull(value) ?? value;
}

async function* keyset<T extends { id: string }>(
  read: (after: Cursor | null, take: number) => Promise<T[]>,
  at: (row: T) => Date,
  take: number,
  onPage?: () => Promise<void>,
): AsyncGenerator<T[]> {
  let after: Cursor | null = null;
  for (;;) {
    const rows = await read(after, take);
    if (rows.length) yield rows;
    if (rows.length < take) return;
    const last = rows[rows.length - 1];
    after = { at: at(last), id: last.id };
    await onPage?.();
  }
}

type RequestRow = Prisma.RequestLogGetPayload<object>;
type ContentRow = { logId: string; request: Prisma.JsonValue; response: Prisma.JsonValue; truncated: boolean };

export function requestRecord(row: RequestRow, content: ContentRow | undefined): ArchiveRecord {
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    key_id: row.keyId,
    user_id: row.userId,
    member_id: row.memberId,
    team_id: row.teamId,
    org_id: row.orgId,
    project_id: row.projectId,
    model: row.model,
    endpoint: row.endpoint,
    deployment_id: row.deploymentId,
    provider: row.provider,
    provider_id: row.providerId,
    upstream_model: row.upstreamModel,
    stream: row.stream,
    status: row.status,
    outcome: row.outcome,
    error: row.error,
    latency_ms: row.latencyMs,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    cost: row.cost.toString(),
    tag: row.tag,
    labels: labelRecord(labelsOf(row.labels)),
    session_id: row.sessionId,
    agent: row.agent,
    pii_mode: row.piiMode,
    pii_input: row.piiInput,
    pii_output: row.piiOutput,
    pii_restore: row.piiRestore ?? null,
    guardrail_input: row.guardInput,
    guardrail_output: row.guardOutput,
    content_skip: row.contentSkip,
    ...(content
      ? { request: content.request ?? null, response: content.response ?? null, content_truncated: content.truncated }
      : {}),
  };
}

const requests: ArchiveSource = {
  dataset: "requests",
  oldest: async () =>
    (await prisma.requestLog.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }))?.createdAt ?? null,
  count: (range) => prisma.requestLog.count({ where: { createdAt: span(range) } }),
  async *records(range: ArchiveDayRange, options: ArchiveReadOptions) {
    const take = options.pageSize ?? (options.includeContent ? CONTENT_PAGE_SIZE : PAGE_SIZE);
    const pages = keyset(
      (after, size) =>
        prisma.requestLog.findMany({
          where: {
            createdAt: span(range),
            ...(after ? { OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: size,
        }),
      (row) => row.createdAt,
      take,
      options.onPage,
    );
    for await (const rows of pages) {
      const contents = options.includeContent
        ? await prisma.requestLogContent.findMany({
            where: { logId: { in: rows.map((row) => row.id) } },
            select: { logId: true, request: true, response: true, truncated: true },
          })
        : [];
      const byLog = new Map(contents.map((content) => [content.logId, content]));
      for (const row of rows) yield requestRecord(row, byLog.get(row.id));
    }
  },
};

const audit: ArchiveSource = {
  dataset: "audit",
  oldest: async () =>
    (await prisma.gatewayAuditLog.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }))?.createdAt ?? null,
  count: (range) => prisma.gatewayAuditLog.count({ where: { createdAt: span(range) } }),
  async *records(range: ArchiveDayRange, options: ArchiveReadOptions) {
    const pages = keyset(
      (after, size) =>
        prisma.gatewayAuditLog.findMany({
          where: {
            createdAt: span(range),
            ...(after ? { OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: size,
        }),
      (row) => row.createdAt,
      options.pageSize ?? PAGE_SIZE,
      options.onPage,
    );
    for await (const rows of pages) {
      for (const row of rows) {
        yield {
          id: row.id,
          created_at: row.createdAt.toISOString(),
          actor: row.actor,
          action: row.action,
          object_type: row.objectType,
          object_id: row.objectId,
          before: jsonOrText(row.beforeJson),
          after: jsonOrText(row.afterJson),
        };
      }
    }
  },
};

const security: ArchiveSource = {
  dataset: "security",
  oldest: async () =>
    (await prisma.userSecurityEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }))?.createdAt ?? null,
  count: (range) => prisma.userSecurityEvent.count({ where: { createdAt: span(range) } }),
  async *records(range: ArchiveDayRange, options: ArchiveReadOptions) {
    const pages = keyset(
      (after, size) =>
        prisma.userSecurityEvent.findMany({
          where: {
            createdAt: span(range),
            ...(after ? { OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: size,
        }),
      (row) => row.createdAt,
      options.pageSize ?? PAGE_SIZE,
      options.onPage,
    );
    for await (const rows of pages) {
      for (const row of rows) {
        yield {
          id: row.id,
          created_at: row.createdAt.toISOString(),
          user_id: row.userId,
          actor: row.actor,
          action: row.action,
          ip_address: row.ipAddress,
        };
      }
    }
  },
};

const tools: ArchiveSource = {
  dataset: "tools",
  oldest: async () =>
    (await prisma.toolExecution.findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } }))?.startedAt ?? null,
  count: (range) => prisma.toolExecution.count({ where: { startedAt: span(range) } }),
  async *records(range: ArchiveDayRange, options: ArchiveReadOptions) {
    const pages = keyset(
      (after, size) =>
        prisma.toolExecution.findMany({
          where: {
            startedAt: span(range),
            ...(after ? { OR: [{ startedAt: { gt: after.at } }, { startedAt: after.at, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
          take: size,
        }),
      (row) => row.startedAt,
      options.pageSize ?? PAGE_SIZE,
      options.onPage,
    );
    for await (const rows of pages) {
      for (const row of rows) {
        yield {
          id: row.id,
          started_at: row.startedAt.toISOString(),
          finished_at: iso(row.finishedAt),
          org_id: row.orgId,
          tool_id: row.toolId,
          tool_version: row.toolVersion,
          agent_id: row.agentId,
          connection_id: row.connectionId,
          actor: row.actor,
          correlation_id: row.correlationId,
          decision: row.decision,
          policy_version: row.policyVersion,
          status: row.status,
          operation: row.operation,
          duration_ms: row.durationMs,
          error: row.error,
          summary: row.summary,
        };
      }
    }
  },
};

export const ARCHIVE_SOURCES: Record<ArchiveDataset, ArchiveSource> = { requests, audit, security, tools };
