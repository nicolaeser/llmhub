import type { ZodType } from "zod";
import type { ParsedRequest, RequestIssue } from "@/types/responses";

function deepestIssue(issue: RequestIssue, base: PropertyKey[]): { path: PropertyKey[]; message: string } {
  const path = [...base, ...issue.path];
  let best: { path: PropertyKey[]; message: string } | null = null;
  if (issue.code === "invalid_union" && issue.errors?.length) {
    for (const branch of issue.errors) {
      for (const child of branch) {
        const found = deepestIssue(child, path);
        if (!best || found.path.length > best.path.length) best = found;
      }
    }
  }
  return best ?? { path, message: issue.message };
}

function requestIssue(issues: RequestIssue[]): { message: string; param: string | null } {
  const first = issues[0];
  if (!first) return { message: "invalid request", param: null };
  const found = deepestIssue(first, []);
  const where = found.path.map(String).join(".");
  return { message: where ? `${where}: ${found.message}` : found.message, param: where || null };
}

export function parseRequest<T>(schema: ZodType<T>, body: unknown): ParsedRequest<T> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, ...requestIssue(result.error.issues as RequestIssue[]) };
}
