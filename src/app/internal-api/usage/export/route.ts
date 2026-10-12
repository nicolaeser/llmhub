import { NextRequest, NextResponse } from "next/server";
import { getFormatter, getNow, getTranslations } from "next-intl/server";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { usageStatsPdf } from "@/lib/http/usage-pdf";

const toDate = (day: string) => new Date(`${day}T00:00:00`);

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 14) || 14;
  const result = await loadUsageAction({
    days,
    model: req.nextUrl.searchParams.get("model") ?? "",
  });
  if (isActionFail(result)) return actionProblem(req, result);
  const t = await getTranslations("Usage");
  const tCommon = await getTranslations("Common");
  const format = await getFormatter();
  const first = result.daily[0]?.day;
  const last = result.daily.at(-1)?.day;
  const pdf = usageStatsPdf({
    stats: result,
    t,
    format,
    brand: tCommon("appName"),
    period: t("pdf.period", {
      days: result.days,
      range: first && last ? format.dateTimeRange(toDate(first), toDate(last), "short") : "",
    }),
    filter: result.model ? t("pdf.filter", { model: result.model }) : undefined,
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
