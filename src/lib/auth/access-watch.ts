import { onActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type { ConsoleAccess } from "@/types/console";

export const ACCESS_CHECK_GAP_MS = 5_000;

const SIGNED_OUT_CODES: ReadonlySet<string> = new Set(["Unauthorized", "UNAUTHORIZED"]);

const DENIED_CODES: ReadonlySet<string> = new Set([
  ...SIGNED_OUT_CODES,
  "FORBIDDEN",
  "Forbidden",
  "PLATFORM_ONLY",
  "INVALID_SCOPE",
  "USER_PROTECTED",
  "ROLE_PROTECTED",
]);

type AccessWatch = {
  key: string;
  check: () => Promise<ConsoleAccess | ActionFail>;
  reload: () => void;
  now?: () => number;
};

let active: AccessWatch | null = null;
let checking = false;
let checkedAt = Number.NEGATIVE_INFINITY;
let reloading = false;

export function deniedCode(code: string): boolean {
  return DENIED_CODES.has(code);
}

export function accessStale(loaded: string, current: unknown): boolean {
  return typeof current === "string" && current !== "" && current !== loaded;
}

function reloadOnce(watch: AccessWatch) {
  if (reloading) return;
  reloading = true;
  watch.reload();
}

export function receiveAccess(key: unknown): void {
  if (active && accessStale(active.key, key)) reloadOnce(active);
}

export function recheckAccess(): void {
  const watch = active;
  if (!watch || checking || reloading) return;
  checking = true;
  checkedAt = (watch.now ?? Date.now)();
  watch.check().then(
    (result) => {
      checking = false;
      if (active !== watch) return;
      if ("key" in result) receiveAccess(result.key);
      else if (SIGNED_OUT_CODES.has(result.error)) reloadOnce(watch);
    },
    () => {
      checking = false;
    },
  );
}

export function noteDenied(code: string): void {
  if (!active || !deniedCode(code)) return;
  if ((active.now ?? Date.now)() - checkedAt < ACCESS_CHECK_GAP_MS) return;
  recheckAccess();
}

export function watchAccess(watch: AccessWatch): () => void {
  active = watch;
  checking = false;
  checkedAt = Number.NEGATIVE_INFINITY;
  reloading = false;
  const stop = onActionFail(noteDenied);
  return () => {
    stop();
    if (active === watch) active = null;
  };
}
