import "server-only";

import type { z } from "zod";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type { AssistantContext, AssistantToolResult, AssistantToolSpec } from "@/types/assistant";

const MAX_ISSUES = 5;

export function defineTool<S extends z.ZodType<Record<string, unknown>>>(spec: {
  description: string;
  input: S;
  run: (args: z.output<S>, ctx: AssistantContext) => Promise<AssistantToolResult>;
}): AssistantToolSpec {
  return {
    description: spec.description,
    input: spec.input,
    call: async (args, ctx) => {
      const parsed = spec.input.safeParse(args);
      if (!parsed.success) {
        return toolFail("invalid_arguments", {
          issues: parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      return spec.run(parsed.data, ctx);
    },
  };
}

export function toolFail(code: string, extra?: Record<string, unknown>): AssistantToolResult {
  return { result: { error: code, ...extra } };
}

export function actionCode(fail: ActionFail): string {
  return fail.error.toLowerCase();
}

export async function viaAction<T>(
  pending: Promise<T | ActionFail>,
  map: (value: T) => AssistantToolResult | Promise<AssistantToolResult>,
): Promise<AssistantToolResult> {
  const value = await pending;
  if (isActionFail(value)) return toolFail(actionCode(value));
  return map(value);
}

export function needsConfirmation(confirm: boolean): AssistantToolResult | null {
  return confirm ? null : toolFail("confirmation_required");
}
