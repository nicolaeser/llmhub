import { NextRequest, NextResponse } from "next/server";
import { getFormatter, getNow, getTranslations } from "next-intl/server";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { usagePdf } from "@/lib/http/usage-pdf";

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
  const totals = result.chargeback.reduce(
    (sum, row) => ({ prompt: sum.prompt + row.prompt, completion: sum.completion + row.completion }),
    { prompt: 0, completion: 0 },
  );
  const pdf = usagePdf({
    brand: tCommon("appName"),
    title: t("pdf.title"),
    period: t("pdf.period", {
      days: result.days,
      range: first && last ? format.dateTimeRange(toDate(first), toDate(last), "short") : "",
    }),
    filter: result.model ? t("pdf.filter", { model: result.model }) : undefined,
    generated: t("pdf.generated", { at: await getNow() }),
    kpis: [
      { label: t("metrics.spend"), value: format.number(result.spend, "money") },
      { label: t("metrics.requests"), value: format.number(result.count, "integer") },
      { label: t("metrics.tokens"), value: format.number(result.tokens, "integer") },
      {
        label: t("successRate"),
        value: format.number(result.count > 0 ? (result.count - result.errors) / result.count : 0, "percent"),
      },
      { label: t("metrics.errors"), value: format.number(result.errors, "integer") },
      { label: t("metrics.rate429"), value: format.number(result.rate429, "integer") },
      { label: t("metrics.latency"), value: t("latencyValue", { ms: Math.round(result.latency) }) },
      { label: t("metrics.p95"), value: t("latencyValue", { ms: Math.round(result.p95Latency) }) },
    ],
    daily: {
      heading: t("charts.dailySpend"),
      days: result.daily.map((day) => ({
        label: format.dateTime(toDate(day.day), "chart"),
        value: day.spend,
      })),
      formatTick: (value) => format.number(value, "axis"),
      empty: t("pdf.noSpend"),
    },
    byModel: {
      heading: t("pdf.byModel"),
      columns: {
        model: t("pdf.colModel"),
        share: t("pdf.colShare"),
        spend: t("pdf.colSpend"),
        prompt: t("pdf.colPrompt"),
        completion: t("pdf.colCompletion"),
      },
      rows: result.byModel.map((row) => {
        const share = result.spend > 0 ? row.spend / result.spend : 0;
        return {
          name: row.name,
          share,
          shareLabel: format.number(share, "percent"),
          spend: format.number(row.spend, "money"),
          prompt: format.number(row.prompt, "integer"),
          completion: format.number(row.completion, "integer"),
        };
      }),
      total: {
        name: t("pdf.total"),
        spend: format.number(result.spend, "money"),
        prompt: format.number(totals.prompt, "integer"),
        completion: format.number(totals.completion, "integer"),
      },
      empty: t("pdf.noSpend"),
    },
  });
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="llmhub-usage.pdf"',
    },
  });
}
