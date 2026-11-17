import { NextRequest, NextResponse } from "next/server";
import { loadUsageFor } from "@/lib/usage/dashboard";
import { getFormatter, getNow, getTranslations } from "next-intl/server";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { isActionFail, runAction } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { exportIdentity } from "@/lib/export/identity";
import { usageStatsPdf } from "@/lib/export/usage-pdf";
import type { AuthenticatedSession } from "@/types/auth";

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);

async function viewerScope(session: AuthenticatedSession) {
  const scope = spendScope(session);
  const company = scope.orgId
    ? await prisma.organization.findUnique({ where: { id: scope.orgId }, select: { alias: true } })
    : null;
  return {
    hasCompany: scope.orgId ? "yes" : "no",
    company: company?.alias || scope.orgId || "",
    own: scope.userId ? "yes" : "no",
    user: session.user.username,
  };
}

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 14) || 14;
  const result = await runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const [usage, viewer] = await Promise.all([
      loadUsageFor(session, {
        days,
        model: req.nextUrl.searchParams.get("model") ?? "",
        labelKey: req.nextUrl.searchParams.get("labelKey") ?? "",
        labelValue: req.nextUrl.searchParams.get("labelValue") ?? "",
      }),
      viewerScope(session),
    ]);
    return { ...usage, viewer };
  });
  if (isActionFail(result)) return actionProblem(req, result);
  const t = await getTranslations("Usage");
  const tCommon = await getTranslations("Common");
  const format = await getFormatter();
  const first = result.daily[0]?.day;
  const last = result.daily.at(-1)?.day;
  const filters = [
    ...(result.model ? [t("pdf.filter", { model: result.model })] : []),
    ...(result.labelValue ? [t("pdf.labelFilter", { key: result.labelKey, value: result.labelValue })] : []),
  ];
  const identity = exportIdentity();
  const pdf = usageStatsPdf({
    stats: { ...result, byLabel: result.labelKey ? [{ key: result.labelKey, rows: result.byLabel }] : [] },
    t,
    format,
    brand: tCommon("appName"),
    instance: identity.instance,
    edition: identity.edition,
    period: t("pdf.period", {
      days: result.days,
      range: first && last ? format.dateTimeRange(toDate(first), toDate(last), "short", { timeZone: "UTC" }) : "",
    }),
    scope: t("pdf.scope", result.viewer),
    filter: filters.length ? format.list(filters, "enumeration") : undefined,
    generatedAt: await getNow(),
    dayDate: toDate,
  });
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="llmhub-usage.pdf"',
    },
  });
}
