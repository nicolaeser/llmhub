import { NextRequest, NextResponse } from "next/server";
import { loadUsage } from "@/lib/usage/dashboard";
import { isActionFail, runAction } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { toCsv } from "@/lib/export/csv";
import { chargebackColumns, chargebackTable } from "@/lib/usage/usage-stats";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30) || 30;
  const result = await runAction(() =>
    loadUsage({
      days,
      model: req.nextUrl.searchParams.get("model") ?? "",
      teamId: req.nextUrl.searchParams.get("teamId") ?? "",
      orgId: req.nextUrl.searchParams.get("orgId") ?? "",
      projectId: req.nextUrl.searchParams.get("projectId") ?? "",
      memberId: req.nextUrl.searchParams.get("memberId") ?? "",
      keyId: req.nextUrl.searchParams.get("keyId") ?? "",
      userId: req.nextUrl.searchParams.get("userId") ?? "",
      labelKey: req.nextUrl.searchParams.get("labelKey") ?? "",
      labelValue: req.nextUrl.searchParams.get("labelValue") ?? "",
    }),
  );
  if (isActionFail(result)) return actionProblem(req, result);
  const columns = chargebackColumns(result.purchase !== null, Boolean(result.labelKey));
  return new NextResponse(toCsv(chargebackTable(result.chargeback, result.names, result.labelKey), columns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="llmhub-chargeback.csv"',
    },
  });
}
