import { errorFields, writeLogLine } from "@/lib/logging/format";
import type { ActionFail } from "@/types/actions";

const ACTION_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|Forbidden|Unauthorized)$/;

export function isActionCode(message: string): boolean {
  return ACTION_CODE.test(message);
}

export function actionFail(error: string): ActionFail {
  return { ok: false, error, message: error };
}

export async function runAction<T>(
  fn: () => Promise<T>,
): Promise<T | ActionFail> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && isActionCode(err.message)) {
      return actionFail(err.message);
    }
    const { errName, err: message } = errorFields(err);
    writeLogLine("error", "action.failed", { errName, err: message });
    return actionFail("REQUEST_FAILED");
  }
}

type FailListener = (error: string) => void;

let failListener: FailListener | null = null;

export function onActionFail(listener: FailListener): () => void {
  failListener = listener;
  return () => {
    if (failListener === listener) failListener = null;
  };
}

export function isActionFail(value: unknown): value is ActionFail {
  const failed = Boolean(
    value &&
      typeof value === "object" &&
      "ok" in value &&
      (value as { ok: unknown }).ok === false,
  );
  if (failed) failListener?.(String((value as ActionFail).error));
  return failed;
}
