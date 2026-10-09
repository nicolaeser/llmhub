import type { NextRequest } from "next/server";
import { getFormatter, getNow, getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/gateway/audit";
import { findRequestLogDetail } from "@/lib/gateway/request-log-detail";
import { fileResponse } from "@/lib/http/export";
import { problemResponse } from "@/lib/http/problem";
import { requestLogMarkdown } from "@/lib/http/request-log-markdown";
import { requestLogPdf } from "@/lib/http/request-log-pdf";
import type {
  RequestLogDetail,
  RequestLogDocument,
  RequestLogDocumentEntry,
  RequestLogExportFormat,
  TranscriptEntry,
} from "@/types/logs";

const FORMATS: readonly RequestLogExportFormat[] = ["pdf", "md", "json"];

const isFormat = (value: string): value is RequestLogExportFormat =>
  FORMATS.includes(value as RequestLogExportFormat);

const pretty = (value: unknown) => (value === null || value === undefined ? "" : JSON.stringify(value, null, 2));

async function requestLogDocument(detail: RequestLogDetail): Promise<RequestLogDocument> {
  const t = await getTranslations("Logs");
  const tDetail = await getTranslations("Logs.detail");
  const tPii = await getTranslations("Guardrails");
  const tCommon = await getTranslations("Common");
  const format = await getFormatter();
  const none = tCommon("none");
  const label = (name: string, id: string) => name || id || none;
  const entities = (ids: string[]) =>
    ids.length ? format.list(ids.map((id) => tPii("entityLabel", { id })), "enumeration") : none;
  const entry = (item: TranscriptEntry): RequestLogDocumentEntry => ({
    role: tDetail("role", { role: item.role }),
    assistant: item.role === "assistant",
    heading:
      item.kind === "tool_call"
        ? tDetail("toolCall", { name: item.name || "" })
        : item.kind === "tool_result"
          ? tDetail("toolResult")
          : item.kind === "reasoning"
            ? tDetail("reasoning")
            : "",
    kind: item.kind,
    text: item.kind === "media" ? tDetail("media", { media: item.text }) : item.text,
  });
  const content = detail.content;
  const status = t("statusOutcome", { status: detail.status, outcome: detail.outcome });

  return {
    brand: tCommon("appName"),
    title: tDetail("title"),
    subtitle: tDetail("subtitle", {
      model: detail.model,
      time: format.dateTime(new Date(detail.createdAt), "zoned"),
    }),
    status,
    generated: tDetail("generated", { at: await getNow() }),
    error: detail.error ? { label: tDetail("error"), text: detail.error } : null,
    fields: [
      { label: tDetail("requestId"), value: detail.id, mono: true },
      { label: t("columns.endpoint"), value: detail.endpoint || none, mono: Boolean(detail.endpoint) },
      { label: t("columns.status"), value: status },
      {
        label: tDetail("upstream"),
        value: detail.upstreamModel
          ? tDetail("upstreamValue", { provider: detail.provider, model: detail.upstreamModel })
          : none,
      },
      { label: tDetail("stream"), value: tDetail("yesNo", { value: String(detail.stream) }) },
      { label: tDetail("tag"), value: detail.tag || none },
      { label: tDetail("key"), value: label(detail.keyLabel, detail.keyId) },
      { label: tDetail("user"), value: label(detail.userLabel, detail.userId) },
      { label: tDetail("member"), value: label(detail.memberLabel, detail.memberId) },
      { label: t("columns.org"), value: label(detail.orgLabel, detail.orgId) },
      { label: tDetail("team"), value: label(detail.teamLabel, detail.teamId) },
      { label: t("columns.project"), value: label(detail.projectLabel, detail.projectId) },
      { label: t("columns.latency"), value: t("latencyMs", { value: detail.latencyMs }) },
      {
        label: t("columns.tokens"),
        value: t("tokenSplit", { prompt: detail.promptTokens, completion: detail.completionTokens }),
      },
      {
        label: tDetail("cache"),
        value: tDetail("cacheValue", { read: detail.cacheReadTokens, written: detail.cacheWriteTokens }),
      },
      { label: t("columns.cost"), value: format.number(detail.cost, "money") },
    ],
    privacy: {
      heading: tDetail("privacy"),
      fields: [
        { label: tDetail("piiFilter"), value: tDetail("piiMode", { mode: detail.piiMode || "none" }) },
        { label: tDetail("piiPrompt"), value: entities(detail.piiInput) },
        { label: tDetail("piiResponse"), value: entities(detail.piiOutput) },
      ],
      note: detail.piiMode ? tDetail("piiStored") : "",
    },
    content: {
      heading: tDetail("content"),
      notice: content
        ? ""
        : !detail.canViewContent && detail.hasContent
          ? tDetail("noPermission")
          : tDetail("contentMissing", { reason: detail.contentSkip || "none" }),
      truncated: content?.truncated ? tDetail("truncated") : "",
      conversation: tDetail("conversation"),
      empty: tDetail("noText"),
      input: content?.input.map(entry) ?? [],
      output: content?.output.map(entry) ?? [],
      payloads: [
        { heading: tDetail("requestJson"), json: pretty(content?.request) },
        { heading: tDetail("responseJson"), json: pretty(content?.response) },
      ],
      noJson: tDetail("noJson"),
    },
    piiLabel: (entity) => tPii("entityLabel", { id: entity }),
    pageLabel: (page, total) => tDetail("page", { page, total }),
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ)) {
    return problemResponse(req, "FORBIDDEN");
  }
  const format = req.nextUrl.searchParams.get("format") ?? "pdf";
  if (!isFormat(format)) {
    return problemResponse(req, "INVALID_PARAMETER", { detail: "format must be pdf, md, or json" });
  }
  const { id } = await ctx.params;
  const detail = await findRequestLogDetail(session, id);
  if (!detail) return problemResponse(req, "NOT_FOUND");
  if (detail.content) {
    await writeAudit({
      actor: session.user.id,
      action: "log.content_export",
      objectType: "request_log",
      objectId: detail.id,
      after: { format },
    });
  }

  const filename = `llmhub-request-${detail.id.replace(/[^\w-]/g, "")}`;
  if (format === "json") {
    return fileResponse(`${JSON.stringify(detail, null, 2)}\n`, `${filename}.json`, "application/json; charset=utf-8");
  }
  const doc = await requestLogDocument(detail);
  if (format === "md") {
    return fileResponse(requestLogMarkdown(doc), `${filename}.md`, "text/markdown; charset=utf-8");
  }
  return fileResponse(Buffer.from(requestLogPdf(doc)), `${filename}.pdf`, "application/pdf");
}
