import { NextRequest, NextResponse } from "next/server";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { toCsv } from "@/lib/http/export";
import { chargebackParts } from "@/lib/gateway/usage-stats";

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
  const rows = result.chargeback.map((row) => {
    const parts = chargebackParts(row.name);
    return {
      org_id: parts.orgId,
      org: result.names[parts.orgId] ?? "",
      team_id: parts.teamId,
      team: result.names[parts.teamId] ?? "",
      project_id: parts.projectId,
      project: result.names[parts.projectId] ?? "",
      member_id: parts.memberId,
      member: result.names[parts.memberId] ?? "",
      key_id: parts.keyId,
      user_id: parts.userId,
      model: parts.model,
      ...(row.purchase === undefined
        ? { spend: row.spend }
        : { purchase_cost: row.purchase, spend: row.spend, margin: row.spend - row.purchase }),
      prompt_tokens: row.prompt,
      completion_tokens: row.completion,
    };
  });
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="llmhub-chargeback.csv"',
    },
  });
}
