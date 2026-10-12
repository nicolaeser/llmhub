import { useCallback, useEffect, useRef, useState } from "react";
import { actionFail, isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";

type Loader<T> = () => Promise<T | ActionFail>;

type Snapshot<T> = {
  data: T | null;
  error: string | null;
  pending: boolean;
};

export type LoadStatus = {
  error: string | null;
  pending: boolean;
  reload: () => void;
};

type Update<T> = T | ((current: T) => T);

export type ActionData<T> = Snapshot<T> &
  LoadStatus & {
    reloadWith: (next: Loader<T>) => void;
    setData: (update: Update<T>) => void;
  };

async function settle<T>(load: Loader<T>): Promise<T | ActionFail> {
  try {
    return await load();
  } catch {
    return actionFail("REQUEST_FAILED");
  }
}

function applyUpdate<T>(update: Update<T>, current: T): T {
  return typeof update === "function" ? (update as (current: T) => T)(current) : update;
}

export function useActionData<T>(load: Loader<T>, onLoad?: (data: T) => void): ActionData<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ data: null, error: null, pending: true });
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
    (next: Loader<T>) => {
      loader.current = next;
      reload();
    },
    [reload],
  );

  const setData = useCallback((update: Update<T>) => {
    setSnapshot((current) =>
      current.data === null ? current : { ...current, data: applyUpdate(update, current.data) },
    );
  }, []);

  return { ...snapshot, reload, reloadWith, setData };
}
