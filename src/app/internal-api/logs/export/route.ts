import type { NextRequest } from "next/server";
import prisma from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, seesAllSpend, spendScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import {
  auditLogWhere,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
} from "@/lib/gateway/request-log-query";
import { fileResponse, toCsv, toJsonl } from "@/lib/http/export";
import { problemResponse } from "@/lib/http/problem";

const KINDS = new Set(["requests", "spend", "audit"]);
const FORMATS = new Set(["csv", "jsonl"]);
const ROW_LIMIT = 5000;
const CONTENT_ROW_LIMIT = 1000;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ)) {
    return problemResponse(req, "FORBIDDEN");
  }
  const url = req.nextUrl;
  const kind = url.searchParams.get("kind") ?? "requests";
  const format = url.searchParams.get("format") ?? "jsonl";
  if (!KINDS.has(kind) || !FORMATS.has(format)) {
    return problemResponse(req, "INVALID_PARAMETER", {
      detail: "kind must be requests, spend, or audit and format must be csv or jsonl",
    });
  }

  const scope = spendScope(session);
  const filters = parseLogFilters(Object.fromEntries(url.searchParams));
  const withContent =
    kind === "requests" && format === "jsonl" && hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT);

  let rows: Record<string, unknown>[];
  if (kind === "requests") {
    const data = await prisma.requestLog.findMany({
      where: requestLogWhere(filters, scope),
      orderBy: { createdAt: "desc" },
      take: withContent ? CONTENT_ROW_LIMIT : ROW_LIMIT,
      include: { content: withContent },
    });
    rows = data.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      model: r.model,
      endpoint: r.endpoint,
      stream: r.stream,
      status: r.status,
      outcome: r.outcome,
      error: r.error,
      latency_ms: r.latencyMs,
      key_id: r.keyId,
      user_id: r.userId,
      member_id: r.memberId,
      team_id: r.teamId,
      org_id: r.orgId,
      project_id: r.projectId,
      deployment_id: r.deploymentId,
      provider: r.provider,
      upstream_model: r.upstreamModel,
      tag: r.tag,
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      cost: r.cost,
      pii_mode: r.piiMode,
      pii_input: format === "csv" ? r.piiInput.join(" ") : r.piiInput,
      pii_output: format === "csv" ? r.piiOutput.join(" ") : r.piiOutput,
      guardrail_input: format === "csv" ? r.guardInput.join("; ") : r.guardInput,
      guardrail_output: format === "csv" ? r.guardOutput.join("; ") : r.guardOutput,
      content_skip: r.contentSkip,
      ...(r.content
        ? { request: r.content.request, response: r.content.response, content_truncated: r.content.truncated }
        : {}),
    }));
    if (withContent) {
      await writeAudit({
        actor: session.user.id,
        action: "log.content_export",
        objectType: "request_log",
        objectId: "export",
        after: { filters, rows: rows.length },
      });
    }
  } else if (kind === "spend") {
    const data = await prisma.spendEvent.findMany({
      where: spendEventWhere(filters, scope),
      orderBy: { createdAt: "desc" },
      take: ROW_LIMIT,
    });
    rows = data.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      model: r.model,
      spend: r.cost,
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      key_id: r.keyId,
      user_id: r.userId,
      member_id: r.memberId,
      team_id: r.teamId,
      org_id: r.orgId,
      project_id: r.projectId,
      deployment: r.deployment,
      tag: r.tag,
    }));
  } else {
    if (!seesAllSpend(session) || companyOf(session)) {
      return problemResponse(req, "FORBIDDEN");
    }
    const data = await prisma.gatewayAuditLog.findMany({
      where: auditLogWhere(filters),
      orderBy: { createdAt: "desc" },
      take: ROW_LIMIT,
    });
    rows = data.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      actor: r.actor,
      action: r.action,
      object_type: r.objectType,
      object_id: r.objectId,
      before: r.beforeJson,
      after: r.afterJson,
    }));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    return fileResponse(
      toCsv(rows),
      `llmhub-${kind}-${stamp}.csv`,
      "text/csv; charset=utf-8",
    );
  }
  return fileResponse(
    toJsonl(rows),
    `llmhub-${kind}-${stamp}.jsonl`,
    "application/x-ndjson; charset=utf-8",
  );
}
