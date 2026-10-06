import { NextRequest, NextResponse } from "next/server";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import { actionProblem } from "@/lib/http/problem";
import { toCsv } from "@/lib/http/export";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30) || 30;
  const result = await loadUsageAction({
    days,
    model: req.nextUrl.searchParams.get("model") ?? "",
    teamId: req.nextUrl.searchParams.get("teamId") ?? "",
    orgId: req.nextUrl.searchParams.get("orgId") ?? "",
    projectId: req.nextUrl.searchParams.get("projectId") ?? "",
    keyId: req.nextUrl.searchParams.get("keyId") ?? "",
    userId: req.nextUrl.searchParams.get("userId") ?? "",
  });
  if (isActionFail(result)) return actionProblem(req, result);
  const rows = result.chargeback.map((row) => {
    const [orgId, teamId, projectId, keyId, userId, model] = row.name.split("/");
    return {
      org_id: orgId,
      team_id: teamId,
      project_id: projectId,
      key_id: keyId,
      user_id: userId,
      model,
      spend: row.spend,
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
