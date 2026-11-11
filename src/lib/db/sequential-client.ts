import "server-only";
import pg from "pg";

export type QueryRunner = (config: unknown, values?: unknown, callback?: unknown) => unknown;
type QueryCallback = (error: unknown, result?: unknown) => void;
type Slot = { ready: Promise<void> | null; release: () => void };

function functionMember(value: unknown, key: "submit" | "callback"): QueryCallback | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const member: unknown = (value as Record<typeof key, unknown>)[key];
  return typeof member === "function" ? (member as QueryCallback) : null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function queryCallback(config: unknown, values: unknown, callback: unknown): QueryCallback | null {
  if (typeof callback === "function") return callback as QueryCallback;
  if (typeof values === "function") return values as QueryCallback;
  return functionMember(config, "callback");
}

export function serializeQueries(run: QueryRunner): QueryRunner {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  function reserve(): Slot {
    const ready = pending > 0 ? tail : null;
    pending += 1;
    let released = false;
    let open!: () => void;
    tail = new Promise<void>((resolve) => {
      open = resolve;
    });
    const release = () => {
      if (released) return;
      released = true;
      pending -= 1;
      open();
    };
    return { ready, release };
  }

  function submit(config: unknown, values: unknown, callback: unknown, slot: Slot): unknown {
    const dispatch = () => {
      try {
        return run(config, values, callback);
      } finally {
        slot.release();
      }
    };
    if (!slot.ready) return dispatch();
    void slot.ready.then(dispatch);
    return config;
  }

  function withCallback(config: unknown, values: unknown, callback: QueryCallback, slot: Slot): undefined {
    const finish: QueryCallback = (error, result) => {
      slot.release();
      callback(error, result);
    };
    const dispatch = () => {
      run(config, typeof values === "function" ? undefined : values, finish);
    };
    if (!slot.ready) {
      try {
        dispatch();
      } catch (error) {
        slot.release();
        throw error;
      }
      return undefined;
    }
    void slot.ready.then(dispatch).catch((error: unknown) => {
      slot.release();
      callback(error);
    });
    return undefined;
  }

  function withPromise(config: unknown, values: unknown, callback: unknown, slot: Slot): unknown {
    const dispatch = () => {
      let result: unknown;
      try {
        result = run(config, values, callback);
      } catch (error) {
        slot.release();
        throw error;
      }
      if (isPromiseLike(result)) result.then(slot.release, slot.release);
      else slot.release();
      return result;
    };
    return slot.ready ? slot.ready.then(dispatch) : dispatch();
  }

  return (config, values, callback) => {
    const slot = reserve();
    if (functionMember(config, "submit")) return submit(config, values, callback, slot);
    const userCallback = queryCallback(config, values, callback);
    if (userCallback) return withCallback(config, values, userCallback, slot);
    return withPromise(config, values, callback, slot);
  };
}

const clientQuery = pg.Client.prototype.query as unknown as (this: pg.Client, ...args: unknown[]) => unknown;

export class SequentialClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    super(config);
    this.query = serializeQueries((config, values, callback) =>
      clientQuery.call(this, config, values, callback),
    ) as unknown as pg.Client["query"];
  }
}
