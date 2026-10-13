import "./async-storage";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";

type Deferred = () => unknown;

export async function withDeferredWork<T>(run: () => Promise<T>): Promise<{ result: T; deferred: Deferred[] }> {
  const deferred: Deferred[] = [];
  const workStore = {
    afterContext: {
      after: (task: unknown) => {
        deferred.push(typeof task === "function" ? (task as Deferred) : () => task);
      },
    },
  };
  const result = await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run({} as never, run));
  return { result, deferred };
}
