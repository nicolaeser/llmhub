import type { ActionFail } from "@/types/actions";

const ACTION_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|Forbidden|Unauthorized)$/;

export function actionFail(error: string): ActionFail {
  return { ok: false, error, message: error };
}

export async function runAction<T>(
  fn: () => Promise<T>,
): Promise<T | ActionFail> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && ACTION_CODE.test(err.message)) {
      return actionFail(err.message);
    }
    return actionFail("REQUEST_FAILED");
  }
}

export function isActionFail(value: unknown): value is ActionFail {
  return Boolean(
    value &&
      typeof value === "object" &&
      "ok" in value &&
      (value as { ok: unknown }).ok === false,
  );
}
