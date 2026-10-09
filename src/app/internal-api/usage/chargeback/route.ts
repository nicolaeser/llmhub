import { NextRequest, NextResponse } from "next/server";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { toCsv } from "@/lib/http/export";
import { chargebackColumns, chargebackTable } from "@/lib/gateway/usage-stats";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30) || 30;
  const result = await loadUsageAction({
    days,
    model: req.nextUrl.searchParams.get("model") ?? "",
    teamId: req.nextUrl.searchParams.get("teamId") ?? "",
    orgId: req.nextUrl.searchParams.get("orgId") ?? "",
    projectId: req.nextUrl.searchParams.get("projectId") ?? "",
    memberId: req.nextUrl.searchParams.get("memberId") ?? "",
    keyId: req.nextUrl.searchParams.get("keyId") ?? "",
    userId: req.nextUrl.searchParams.get("userId") ?? "",
  });
  if (isActionFail(result)) return actionProblem(req, result);
  const columns = chargebackColumns(result.purchase !== null);
  return new NextResponse(toCsv(chargebackTable(result.chargeback, result.names), columns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="llmhub-chargeback.csv"',
    },
  });
}
