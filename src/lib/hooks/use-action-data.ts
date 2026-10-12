import { useCallback, useEffect, useRef, useState } from "react";
import { actionFail, isActionFail } from "@/lib/http/action-result";
import type { ActionData, ActionDataUpdate, ActionFail, ActionLoader, ActionSnapshot } from "@/types/actions";

async function settle<T>(load: ActionLoader<T>): Promise<T | ActionFail> {
  try {
    return await load();
  } catch {
    return actionFail("REQUEST_FAILED");
  }
}

function applyUpdate<T>(update: ActionDataUpdate<T>, current: T): T {
  return typeof update === "function" ? (update as (current: T) => T)(current) : update;
}

export function useActionData<T>(load: ActionLoader<T>, onLoad?: (data: T) => void): ActionData<T> {
  const [snapshot, setSnapshot] = useState<ActionSnapshot<T>>({ data: null, error: null, pending: true });
  const loader = useRef(load);
  const listener = useRef(onLoad);
  const latest = useRef(0);

  useEffect(() => {
    listener.current = onLoad;
  });

  const run = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await settle(loader.current);
    if (ticket !== latest.current) return;
    if (isActionFail(result)) {
      const error = result.error;
      setSnapshot((current) => ({ ...current, error, pending: false }));
      return;
    }
    setSnapshot({ data: result, error: null, pending: false });
    listener.current?.(result);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const reload = useCallback(() => {
    setSnapshot((current) => ({ ...current, pending: true }));
    void run();
  }, [run]);

  const reloadWith = useCallback(
    (next: ActionLoader<T>) => {
      loader.current = next;
      reload();
    },
    [reload],
  );

  const setData = useCallback((update: ActionDataUpdate<T>) => {
    setSnapshot((current) =>
      current.data === null ? current : { ...current, data: applyUpdate(update, current.data) },
    );
  }, []);

  return { ...snapshot, reload, reloadWith, setData };
}
