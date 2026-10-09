import "server-only";
import prisma from "@/lib/db/prisma";
import { asRecord } from "@/lib/gateway/core";
import { logPayload } from "@/lib/gateway/log-content";
import { defaultEntityIds, redactJSON, redactPii } from "@/lib/gateway/pii";
import { getEnterprise, resolvePii } from "@/lib/gateway/settings";
import type { Prisma } from "@/generated/prisma/client";
import type { Deployment, Enterprise, Principal } from "@/types/gateway";
import type { ContentSkip } from "@/types/logs";

const ERROR_LIMIT = 2_000;

export type RequestLogEntry = {
  principal: Principal;
  model: string;
  deployment?: Deployment | null;
  status: number;
  outcome: string;
  latencyMs: number;
  tag: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  stream?: boolean;
  request?: unknown;
  response?: unknown;
  error?: unknown;
};

export async function contentSkip(principal: Principal, enterprise: Enterprise): Promise<ContentSkip> {
  if (enterprise.log_content === false) return "gateway";
  if (principal.key && principal.key.log_content === false) return "key";
  if (principal.memberId) {
    const member = await prisma.member.findUnique({
      where: { id: principal.memberId },
      select: { logContent: true },
    });
    if (member && !member.logContent) return "member";
  }
  if (!principal.userId) return "";
  const user = await prisma.user.findUnique({
    where: { id: principal.userId },
    select: { logContent: true },
  });
  return user && !user.logContent ? "user" : "";
}

function errorText(error: unknown): string {
  if (!error) return "";
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.slice(0, ERROR_LIMIT);
}

export async function writeRequestLog(entry: RequestLogEntry): Promise<void> {
  const [enterprise, pii] = await Promise.all([getEnterprise(), resolvePii(entry.principal)]);
  const trace = entry.principal.trace;
  const piiOn = pii.enabled;
  const entities = pii.entities.length ? pii.entities : defaultEntityIds();
  const piiInput = new Set(trace?.piiInput ?? []);
  const piiOutput = new Set(trace?.piiOutput ?? []);
  const scanned = Boolean(trace?.piiMode);
  let request = trace?.request ?? entry.request;
  let response = entry.response;
  let error = errorText(entry.error);
  let tag = entry.tag;
  if (piiOn) {
    if (request !== undefined && !scanned) request = redactJSON(request, entities, "", piiInput);
    if (response !== undefined) response = redactJSON(response, entities, "", piiOutput);
    if (error) error = redactPii(error, entities);
    if (tag) tag = redactPii(tag, entities);
  }
  const skip = await contentSkip(entry.principal, enterprise);
  const stored = skip ? null : { request: logPayload(request), response: logPayload(response) };
  const content =
    stored && (stored.request || stored.response)
      ? {
          create: {
            ...(stored.request ? { request: stored.request.value as Prisma.InputJsonValue } : {}),
            ...(stored.response ? { response: stored.response.value as Prisma.InputJsonValue } : {}),
            truncated: Boolean(stored.request?.truncated || stored.response?.truncated),
          },
        }
      : undefined;
  const streamFlag = asRecord(request)?.stream;
  const dims = {
    keyId: entry.principal.key?.token_id ?? "",
    userId: entry.principal.userId,
    teamId: entry.principal.teamId,
    orgId: entry.principal.orgId,
    projectId: entry.principal.key?.project_id ?? "",
    memberId: entry.principal.memberId,
  };
  const meta = {
    model: entry.model,
    endpoint: trace?.endpoint ?? "",
    deploymentId: entry.deployment?.id ?? "",
    provider: entry.deployment?.kind ?? "",
    upstreamModel: entry.deployment?.model ?? "",
    stream: entry.stream ?? (streamFlag === true || streamFlag === "true"),
    tag,
    status: entry.status,
    outcome: entry.outcome,
    error,
    latencyMs: entry.latencyMs,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    piiMode: trace?.piiMode ?? "",
    piiInput: [...piiInput],
    piiOutput: [...piiOutput],
    contentSkip: skip,
  };
  const log = await prisma.requestLog.create({
    data: { ...dims, ...meta, cost: entry.cost, ...(content ? { content } : {}) },
  });

  try {
    if (!enterprise.log_archive) return;
    const { archiveLogJson } = await import("@/lib/s3/logs");
    await archiveLogJson("requests", log.id, {
      id: log.id,
      created_at: log.createdAt.toISOString(),
      key_id: dims.keyId,
      user_id: dims.userId,
      team_id: dims.teamId,
      org_id: dims.orgId,
      project_id: dims.projectId,
      member_id: dims.memberId,
      model: meta.model,
      endpoint: meta.endpoint,
      deployment_id: meta.deploymentId,
      provider: meta.provider,
      upstream_model: meta.upstreamModel,
      stream: meta.stream,
      status: meta.status,
      outcome: meta.outcome,
      error: meta.error,
      latency_ms: meta.latencyMs,
      prompt_tokens: meta.promptTokens,
      completion_tokens: meta.completionTokens,
      cache_read_tokens: meta.cacheReadTokens,
      cache_write_tokens: meta.cacheWriteTokens,
      cost: entry.cost,
      tag: meta.tag,
      pii_mode: meta.piiMode,
      pii_input: meta.piiInput,
      pii_output: meta.piiOutput,
      content_skip: skip,
      ...(stored?.request ? { request: stored.request.value } : {}),
      ...(stored?.response ? { response: stored.response.value } : {}),
    });
  } catch {}
}
