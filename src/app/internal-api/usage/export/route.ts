import { NextRequest, NextResponse } from "next/server";
import { loadUsage } from "@/lib/usage/dashboard";
import { getFormatter, getNow, getTranslations } from "next-intl/server";
import { isActionFail, runAction } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { usageStatsPdf } from "@/lib/export/usage-pdf";

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 14) || 14;
  const result = await runAction(() =>
    loadUsage({
      days,
      model: req.nextUrl.searchParams.get("model") ?? "",
      labelKey: req.nextUrl.searchParams.get("labelKey") ?? "",
      labelValue: req.nextUrl.searchParams.get("labelValue") ?? "",
    }),
  );
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
  const pdf = usageStatsPdf({
    stats: { ...result, byLabel: result.labelKey ? [{ key: result.labelKey, rows: result.byLabel }] : [] },
    t,
    format,
    brand: tCommon("appName"),
    period: t("pdf.period", {
      days: result.days,
      range: first && last ? format.dateTimeRange(toDate(first), toDate(last), "short", { timeZone: "UTC" }) : "",
    }),
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
